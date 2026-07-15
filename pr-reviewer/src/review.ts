import {
  completeStructured,
  schemaPromptEcho,
  capToBudget,
  historyBudgetTokens,
} from '../../core/src/index.ts';
import type { ChatCompletionClient, ChatMessage } from '../../core/src/index.ts';
import type { DiffFile } from './diff.ts';
import { REVIEW_SCHEMA, coerceReviewResult } from './schema.ts';
import type { ReviewResult } from './schema.ts';

/** Вход ревью: метаданные PR, изменённые файлы (с ханками), фрагменты доков и содержимое файлов. */
export interface ReviewInput {
  title: string;
  description: string;
  files: DiffFile[];
  /** Фрагменты документации проекта (из grounding через RAG). */
  docFragments: string[];
  /** Полное содержимое изменённых файлов (для понимания кода вокруг ханков). */
  fileContents: { path: string; content: string }[];
}

/** Зависимости генерации ревью. */
export interface ReviewDeps {
  client: ChatCompletionClient;
  structuredOutputs?: boolean;
  disableThinking: boolean;
  requestTimeoutMs: number;
  temperature: number;
  /** Потолок токенов ответа. */
  maxTokens: number;
  /** Контекст модели — для бюджета входа. */
  contextTokens: number;
}

/** Роль ревьюера: три категории, привязка к строкам, запрет выдумки, few-shot. */
const REVIEWER_SYSTEM =
  'Ты — строгий, но доброжелательный ревьюер кода. Тебе дан diff PR (unified). Ревьюируй ТОЛЬКО ' +
  'добавленные и изменённые строки (со стороны «+» diff) — не комментируй нетронутый код и не давай ' +
  'общих советов «на будущее».\n' +
  'Категории (поле severity):\n' +
  '- "bug" — реальная ошибка в ИЗМЕНЕНИИ: неверная логика, необработанный краевой случай (null/пусто/' +
  'granica массива), утечка, гонка, регресс поведения;\n' +
  '- "architecture" — проблема устройства: нарушение слоёв, дублирование, лишняя связность, утечка ' +
  'абстракции — видимая ПРЯМО в этих изменениях;\n' +
  '- "recommendation" — полезное улучшение по существу изменения;\n' +
  '- "nitpick" — мелочь (имя, формат, комментарий).\n' +
  'Правила: каждая находка — на КОНКРЕТНОЙ строке новой версии (правая сторона diff). Опирайся ТОЛЬКО ' +
  'на то, что видно в diff и приложенных материалах; не домысливай содержимое файлов, зависимости или ' +
  'поведение, которых не видишь. Не уверен — не пиши. Нет замечаний — верни пустой список findings ' +
  '(это нормально и хорошо). Один и тот же дефект — одна находка. body: коротко ЧТО не так и КАК ' +
  'исправить.\n' +
  'Пример хорошей находки: {"file":"src/user.ts","line":42,"severity":"bug","title":"Возможный null",' +
  '"body":"user.email может быть undefined — обращение .toLowerCase() упадёт. Добавьте проверку."} ' +
  'Пример ПЛОХОЙ (так НЕ делай): выдумка про строку вне diff или совет «добавьте тесты» без привязки ' +
  'к конкретной изменённой строке.';

/** Собирает пользовательское сообщение из секций, каждая — под своим бюджетом токенов. */
function buildUserMessage(input: ReviewInput, budgetTokens: number): string {
  const docsText = capToBudget(input.docFragments.join('\n\n'), Math.floor(budgetTokens * 0.25));
  const filesText = capToBudget(
    input.fileContents.map(file => `Файл ${file.path}:\n${file.content}`).join('\n\n'),
    Math.floor(budgetTokens * 0.3),
  );
  const diffText = capToBudget(
    input.files.map(file => `${file.status} ${file.path}\n${file.patch}`).join('\n\n'),
    Math.floor(budgetTokens * 0.45),
  );
  const sections = [`PR: ${input.title}`];
  if (input.description.trim() !== '') {
    sections.push(`Описание:\n${input.description}`);
  }
  if (docsText.trim() !== '') {
    sections.push(`Документация проекта (контекст):\n${docsText}`);
  }
  if (filesText.trim() !== '') {
    sections.push(`Содержимое изменённых файлов:\n${filesText}`);
  }
  sections.push(`Изменения на ревью (unified diff):\n${diffText}`);
  return sections.join('\n\n');
}

/**
 * Генерирует ревью: собирает промпт (метаданные PR + доки + содержимое файлов + diff, каждая секция
 * под бюджетом токенов) и зовёт общий `completeStructured` со схемой `REVIEW_SCHEMA`. Толерантный
 * разбор безопасен и для z.ai/GLM (схема идёт промптом), и для Ollama (constrained decoding).
 */
export async function generateReview(deps: ReviewDeps, input: ReviewInput): Promise<ReviewResult> {
  const budget = historyBudgetTokens(deps.contextTokens, deps.maxTokens);
  const messages: ChatMessage[] = [
    { role: 'system', content: `${REVIEWER_SYSTEM}\n\n${schemaPromptEcho(REVIEW_SCHEMA)}` },
    { role: 'user', content: buildUserMessage(input, budget) },
  ];
  const parsed = await completeStructured(deps.client, messages, {
    schema: REVIEW_SCHEMA,
    ...(deps.structuredOutputs === undefined ? {} : { structuredOutputs: deps.structuredOutputs }),
    maxTokens: deps.maxTokens,
    temperature: deps.temperature,
    disableThinking: deps.disableThinking,
    requestTimeoutMs: deps.requestTimeoutMs,
  });
  return coerceReviewResult(parsed);
}
