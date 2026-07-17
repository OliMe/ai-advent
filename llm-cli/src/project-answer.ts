import { formatWorkspace } from '../../core/src/index.ts';
import type {
  ChatCompletionClient,
  ChatMessage,
  GenerationLimits,
  ProjectContext,
  ToolSet,
  Usage,
} from '../../core/src/index.ts';
import { askModel } from './chat.ts';
import { forcedRagSearch } from './grounded.ts';
import { resolveRagAnswer, toEvidenceChunks } from '../../grounding/src/index.ts';
import type { ToolEvidence } from '../../grounding/src/index.ts';
import { isGitBranchTool, isGitStatusTool, workspaceDocSources } from './project.ts';
import {
  CODE_SEARCH_SYSTEM,
  projectFileListings,
  parseCodePatterns,
  filesMatchingPatterns,
  forcedCodeSearch,
  filesFromHits,
  forcedFileReads,
  citationCandidates,
  MAX_FILES_TO_READ,
} from './code-search.ts';
import type { Conversation } from '../../core/src/index.ts';

/** Префикс команды вопроса о проекте. */
const ASK_PREFIX = '/ask ';

/**
 * Вопрос ассистенту разработчика из ввода: `/ask <вопрос>` → вопрос. Не команда `/ask` — null (тогда
 * ввод идёт обычным путём). Разбор ДО реестра команд: дальше ход переиспользует общий путь ответа.
 */
export function parseProjectQuestion(input: string): string | null {
  if (!input.startsWith(ASK_PREFIX)) {
    return null;
  }
  const question = input.slice(ASK_PREFIX.length).trim();
  return question === '' ? null : question;
}

/** Подсказка при `/ask` без вопроса. */
export const ASK_USAGE =
  'Спросите о проекте: /ask <вопрос> — например «/ask какая структура у проекта?» или ' +
  '«/ask где обрабатывается авторизация?». Проекты — /project.\n\n';

/** Нет ни одного привязанного проекта — отвечать не о чем. */
export const ASK_NO_PROJECT =
  '⚠ Проект не привязан, отвечать не о чем. Привяжите: /project add <путь|git URL>.\n\n';

/** Нет инструментов (MCP выключен) — ни документации, ни кода добыть нечем. */
export const ASK_NO_TOOLS =
  '⚠ Нет инструментов: подключите rag-mcp (поиск по документации) и git-mcp (код и состояние ' +
  'репозитория) — иначе ответ о проекте будет выдумкой. См. /mcp.\n\n';

/**
 * Директива ассистента разработчика: весь материал (документация, места в коде, файлы) уже добыт
 * инструментами ДО генерации — модели остаётся синтез. Формат из трёх секций — тот же, что у
 * RAG-ответа (День 24): его проверяет цитатный гейт, где доказательствами служат и фрагменты
 * документации, и прочитанный код.
 */
export function projectAssistantDirective(projects: ProjectContext[]): string {
  const names = projects.map(project => project.name).join(', ');
  return (
    `Ты — ассистент разработчика по проектам: ${names}. Отвечай ТОЛЬКО по тому, что приведено ниже: ` +
    'фрагменты документации, найденные места в коде и содержимое файлов. Всё это уже добыто из ' +
    'репозитория — искать что-то ещё не нужно.\n' +
    'Не выдумывай пути, имена файлов и функции: чего нет в приведённых материалах — того не ' +
    'утверждай. Не нашлось ответа — так и скажи.\n' +
    'Формат ответа — РОВНО три секции:\n' +
    'Ответ: <по существу>\n' +
    'Источники:\n- <файл документации или файл кода, откуда взято>\n' +
    'Цитаты:\n- «<ДОСЛОВНАЯ выдержка из фрагмента документации или из кода выше>»\n' +
    'Цитата обязана быть дословной подстрокой приведённого материала (скопируй символ в символ).'
  );
}

/** Собирает git-контекст проектов: ветка и изменённые файлы (детерминированно, до генерации). */
export async function collectGitContext(
  toolSet: ToolSet,
  projects: ProjectContext[],
): Promise<string> {
  const specs = toolSet.specs();
  const branchTool = specs.find(spec => isGitBranchTool(spec.name))?.name;
  const statusTool = specs.find(spec => isGitStatusTool(spec.name))?.name;
  if (branchTool === undefined || statusTool === undefined) {
    return '';
  }
  const blocks: string[] = [];
  for (const project of projects) {
    const branch = await toolSet.call(branchTool, { repo: project.root });
    const status = await toolSet.call(statusTool, { repo: project.root });
    blocks.push(`${project.name}:\n${branch.trim()}\nИзменения:\n${status.trim()}`);
  }
  return `Текущее состояние репозиториев:\n\n${blocks.join('\n\n')}`;
}

/** Зависимости хода вопроса о проекте. */
export interface ProjectAnswerDeps {
  client: ChatCompletionClient;
  /** Окно истории диалога (последним идёт вопрос пользователя). */
  history: ChatMessage[];
  question: string;
  projects: ProjectContext[];
  tools: ToolSet;
  limits: GenerationLimits;
  requestTimeoutMs: number;
  disableThinking: boolean;
  /** Температура синтеза ответа — низкая: ответ собирается по фактам, творчество тут вредит. */
  temperature: number;
  onToolCall: (name: string, args: Record<string, unknown>) => void;
  onToolResult: (name: string, result: string) => void;
  onCitationFailure?: (reason: string, attempt: number) => void;
  faithfulness?: {
    makeChecker: () => Conversation;
    onUnfaithful?: (issues: string[], attempt: number) => void;
  };
}

/** Результат хода: итоговый ответ, расход токенов и трасса вызванных инструментов. */
export interface ProjectAnswer {
  content: string;
  usage: Usage | undefined;
  calledTools: string[];
}

/**
 * Ход `/ask` — ПОЛНОСТЬЮ детерминированный сбор доказательств, затем tool-free синтез:
 * карточки проектов + git-контекст → форс-поиск по документации всех проектов → выбор шаблонов для
 * grep (узкая подзадача модели, по РЕАЛЬНОМУ списку файлов) → форс-grep → чтение найденных файлов →
 * ответ по собранному → цитатный гейт (доказательства — и доки, и код).
 *
 * Инструменты вызываем МЫ, а не модель: агентный цикл на слабой локальной модели вырождался в
 * бесконечное чтение выдуманного файла, и ответа не было вовсе. Так же устроен grounded Дня 25.
 */
export async function answerProjectQuestion(deps: ProjectAnswerDeps): Promise<ProjectAnswer> {
  const calledTools: string[] = [];
  const evidence: ToolEvidence[] = [];
  const ragResults: string[] = [];

  const leading: ChatMessage[] = [
    { role: 'system', content: projectAssistantDirective(deps.projects) },
    { role: 'system', content: formatWorkspace(deps.projects) },
  ];
  const gitContext = await collectGitContext(deps.tools, deps.projects);
  if (gitContext !== '') {
    leading.push({ role: 'system', content: gitContext });
  }
  // Документация — принудительным поиском по КАЖДОМУ источнику КАЖДОГО проекта: полагаться на то,
  // что модель сама догадается искать, нельзя (слабая модель не догадывается).
  const docSources = workspaceDocSources(deps.projects);
  const found = await forcedRagSearch(
    deps.tools,
    docSources,
    deps.question,
    (name, args, result) => {
      calledTools.push(name);
      deps.onToolCall(name, args);
      deps.onToolResult(name, result);
    },
  );
  ragResults.push(...found);
  if (found.length > 0) {
    leading.push({
      role: 'system',
      content: `Найденные фрагменты документации (эти источники повторно не ищи):\n${found.join('\n\n')}`,
    });
  }

  // Код — тоже принудительно: модель называет ЧТО искать (узкая подзадача, посильная и слабой
  // модели), а git_grep вызываем сами. Без этого слабая модель в код не идёт вовсе и отвечает по
  // документации мимо вопроса (воспроизводилось на qwen2.5:7b).
  const listings = await projectFileListings(
    deps.tools,
    deps.projects.map(project => project.root),
  );
  const listingText = [...listings.entries()]
    .map(([root, paths]) => `${root}:\n${paths.join('\n')}`)
    .join('\n\n');
  const plan = await askModel(
    deps.client,
    [
      { role: 'system', content: CODE_SEARCH_SYSTEM },
      ...(listingText === ''
        ? []
        : [{ role: 'system' as const, content: `Файлы проекта:\n${listingText}` }]),
      { role: 'user', content: deps.question },
    ],
    deps.requestTimeoutMs,
    deps.limits,
    deps.disableThinking,
    0,
  );
  const patterns = parseCodePatterns(plan.content);
  const projectRoots = deps.projects.map(project => project.root);
  const hits = await forcedCodeSearch(deps.tools, projectRoots, patterns, (name, args, result) => {
    calledTools.push(name);
    deps.onToolCall(name, args);
    deps.onToolResult(name, result);
  });
  evidence.push(...hits);
  if (hits.length > 0) {
    const codeHits = hits.map(hit => `${hit.args.pattern}:\n${hit.result}`).join('\n\n');
    leading.push({
      role: 'system',
      content: `Найденные места в КОДЕ (файл:строка):\n${codeHits}`,
    });
  }

  // Что читать целиком: сперва файлы, чьё ИМЯ названо шаблоном (прямое указание — «citation-guard»),
  // затем файлы из совпадений grep. По строке-совпадению код не понять, а сам файл-определение в
  // выдачу grep может и не попасть (там будут лишь его упоминания в импортах и документации).
  const named = deps.projects.flatMap(project =>
    filesMatchingPatterns(listings.get(project.root) ?? [], patterns).map(path => ({
      repo: project.root,
      path,
    })),
  );
  const toRead = [...named, ...filesFromHits(hits)]
    .filter(
      (file, index, all) =>
        all.findIndex(other => other.repo === file.repo && other.path === file.path) === index,
    )
    .slice(0, MAX_FILES_TO_READ);
  const files = await forcedFileReads(deps.tools, toRead, (name, args, result) => {
    calledTools.push(name);
    deps.onToolCall(name, args);
    deps.onToolResult(name, result);
  });
  evidence.push(...files);
  if (files.length > 0) {
    const bodies = files.map(file => `${file.args.path}:\n${file.result}`).join('\n\n');
    leading.push({ role: 'system', content: `Содержимое файлов:\n${bodies}` });
  }

  // Готовые кандидаты для секции «Цитаты»: слабая модель пересказывает вместо цитирования и валит
  // гейт (пять перегенераций → фолбэк, ответа нет). «Скопируй одну строку» ей посильно. Порядок —
  // сперва прочитанный КОД, потом совпадения grep: иначе в кандидаты (и в ответ) попадали строки
  // документации, упоминающие файл, вместо самого кода.
  const candidates = citationCandidates([...files, ...hits], patterns);
  if (candidates.length > 0) {
    leading.push({
      role: 'system',
      content:
        'Готовые ДОСЛОВНЫЕ строки для секции «Цитаты» — скопируй в ответ хотя бы ОДНУ из них ' +
        `символ в символ:\n${candidates.map(candidate => `- «${candidate}»`).join('\n')}`,
    });
  }

  const outgoing = [...leading, ...deps.history];
  // Синтез — TOOL-FREE, как grounded-ответ Дня 25. Доказательства уже собраны детерминированно
  // (доки + grep + файлы), и модели остаётся только собрать по ним ответ. Агентный цикл здесь ВРЕДЕН:
  // слабая локальная модель (qwen2.5:7b) вместо синтеза десятками раундов читала ВЫДУМАННЫЙ файл
  // «gates/citation_gate.txt», пока не кончился лимит раундов — ответа не было вовсе. Заодно первый
  // проход становится консистентным с перегенерацией гейта (она и так tool-free).
  const result = await askModel(
    deps.client,
    outgoing,
    deps.requestTimeoutMs,
    deps.limits,
    deps.disableThinking,
    deps.temperature,
  );

  const content = await resolveRagAnswer({
    ragResults,
    extraChunks: toEvidenceChunks(evidence),
    initial: result.content,
    // Перегенерация — БЕЗ инструментов: доказательства уже собраны, повторно ходить в репозиторий
    // незачем. Замечание гейта СОПРОВОЖДАЕМ исходным вопросом: слабая модель иначе принимает
    // замечание за новый вопрос и отвечает на него («проверка цитат не пройдена, добавьте
    // источники…») — формально с цитатами, но мимо того, что спросил пользователь.
    regenerate: async feedback => {
      const restated = `${feedback}\n\nОтвечай на ИСХОДНЫЙ вопрос (не на это замечание): ${deps.question}`;
      const fix = [...outgoing, { role: 'user' as const, content: restated }];
      const fixed = await askModel(
        deps.client,
        fix,
        deps.requestTimeoutMs,
        deps.limits,
        deps.disableThinking,
        deps.temperature,
      );
      return fixed.content;
    },
    ...(deps.onCitationFailure === undefined ? {} : { onFailure: deps.onCitationFailure }),
    ...(deps.faithfulness === undefined ? {} : { faithfulness: deps.faithfulness }),
  });

  return { content, usage: result.usage, calledTools };
}
