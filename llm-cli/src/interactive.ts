import * as readline from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import {
  createSession,
  emptyProfile,
  DEFAULT_PROFILE_NAME,
  historyTokens,
  historyBudgetTokens,
  formatUsageStats,
  formatSessionTotals,
  estimateTokens,
  createMemoryStrategy,
  MemoryManager,
  layerBudgets,
  enforceInvariants,
  InvariantViolationError,
  INVARIANT_CHECKER_SYSTEM,
} from '../../core/src/index.ts';
import type {
  AppConfig,
  ChatCompletionClient,
  GenerationLimits,
  ProfileStore,
  InvariantsStore,
  RunStore,
  Session,
  SessionStore,
  Task,
  TaskStore,
  Usage,
  MemoryKind,
  MemoryWriteReport,
} from '../../core/src/index.ts';
import { askModel, streamAnswer, completeWithTools } from './chat.ts';
import { newSession, branchNameTaken, resolveBranch } from './session-flow.ts';
import { makeConversationFactory, RunController } from './run-flow.ts';
import { MemoryRunBridge } from './run-task-bridge.ts';
import { parseServerSpec } from './mcp-store.ts';
import type { McpStore } from './mcp-store.ts';
import type { McpServerConfig, McpToolSet } from '../../mcp-client/src/index.ts';
import {
  LocalImageRecognizingToolSet,
  recognizeTextDirective,
  isRecognizeTool,
} from './recognize-local.ts';
import { CompositeToolSet } from './composite-tool-set.ts';
import { LocationToolSet } from './location.ts';
import { currentTimeContext } from './current-time.ts';
import { TOOL_HONESTY_DIRECTIVE, claimsSchedulerActionWithoutCall } from './tool-honesty.ts';
import { installClipboardPaste, type ClipboardImageReader } from './clipboard-image.ts';
import { parseList, isAffirmative, isNegative } from './replies.ts';
import { readlineConfirm, type ElicitationBridge } from './elicitation.ts';
import { renderMarkdownForTerminal } from './markdown.ts';
import {
  ragSearchDirective,
  isSearchDocsTool,
  formatRagResultForDisplay,
  queryMentionsSource,
} from './rag-directive.ts';
import { resolveRagAnswer } from './citation-guard.ts';
import { FAITHFULNESS_CHECKER_SYSTEM } from './faithfulness.ts';
import {
  isConversationalReply,
  isRecallTurn,
  isRecallFallback,
  RECALL_SYSTEM_PROMPT,
  RAG_SEARCH_UNAVAILABLE,
  resolveRagAnswerTemperature,
  groundedFocus,
  buildGroundedQuery,
  forcedRagSearch,
} from './grounded.ts';
import type { VoiceInput } from './voice-input.ts';
import {
  helpText,
  formatSessionList,
  formatTaskList,
  formatCurrentTask,
  formatProfile,
  formatProfileList,
  formatInvariants,
  formatMcpTools,
  formatToolTrace,
  EPHEMERAL_NOTICE,
  MEMORY_OFF_NOTICE,
} from './formatters.ts';
import { readFileContent, formatAttachment } from './files.ts';
import { validTemperature } from './args.ts';
import { describeError } from './errors.ts';

/** Метка ответа модели в интерактивном режиме. */
const ASSISTANT_LABEL = 'Ассистент';

/** Параметры слоистой памяти для интерактивного режима. */
export interface MemorySettings {
  /** Включена ли слоистая память (профиль + задача). */
  enabled: boolean;
  /** Хранилища; null — в памяти на сессию, без записи на диск (--ephemeral). */
  profileStore: ProfileStore | null;
  taskStore: TaskStore | null;
  /** Хранилище глобальных инвариантов; null — в памяти (--ephemeral). */
  invariantsStore?: InvariantsStore | null;
  /** Переопределение размеров слоёв (иначе — эвристика от контекста). */
  profileTokens?: number;
  taskTokens?: number;
  /** Стартовая задача (из флага --task). */
  initialTaskTitle?: string;
  /** Имя активного профиля на старте (из --profile или указателя хранилища). */
  profileName?: string;
}

/** Перезаписывает системное сообщение сессии (действует с этого момента). */
function setSystemPrompt(session: Session, text: string): void {
  session.messages[0] = { role: 'system', content: text };
  session.updatedAt = new Date().toISOString();
}

/** Интерактивный режим: диалог с сохранением истории. */
export async function runInteractive(
  client: ChatCompletionClient,
  config: AppConfig,
  limits: GenerationLimits,
  disableThinking: boolean,
  temperature: number,
  stream: boolean,
  // Стратегия управления памятью диалога (окно/сжатие) и сколько свежего держать.
  memory: MemoryKind,
  keepRecent: number,
  // Транскрипт сессии (с системным сообщением); store=null — без персистентности.
  session: Session,
  store: SessionStore | null,
  input: Readable,
  output: Writable,
  // Передаётся явно — это же даёт тестам шов для подмены интерфейса.
  createInterface: typeof readline.createInterface,
  // Слоистая память (профиль + задача); по умолчанию выключена.
  memorySettings: MemorySettings = { enabled: false, profileStore: null, taskStore: null },
  // Хранилище прогонов задач (пайплайн); null — в памяти (--ephemeral).
  runStore: RunStore | null = null,
  // Инструменты MCP (набор + хранилище конфигурации + мост подтверждений); null — MCP выключен.
  mcp: {
    toolSet: McpToolSet;
    store: McpStore;
    elicitationBridge?: ElicitationBridge;
  } | null = null,
  // Источник картинки из буфера обмена (Ctrl+V); null — перехват выключен (напр. в тестах).
  clipboard: ClipboardImageReader | null = null,
  // Голосовой ввод (микрофон → текст); null — выключен (нет кредов/не терминал/тесты).
  voice: VoiceInput | null = null,
): Promise<void> {
  const readlineInterface = createInterface({ input, output });
  // Терминал ли вывод — от этого зависит, рендерить ли markdown ответа в ANSI (в пайпах/тестах нет).
  const isTty = (output as Writable & { isTTY?: boolean }).isTTY === true;
  // Запрос подтверждения для операций вне песочницы (MCP elicitation): спрашиваем пользователя да/нет.
  mcp?.elicitationBridge?.setConfirm(
    readlineConfirm(readlineInterface.question.bind(readlineInterface), isAffirmative),
  );
  // Инструменты агентам (чат + пайплайн): MCP-инструменты с локальной обработкой путей
  // (recognize-text) плюс клиентский get_my_location (геолокация для задач вроде погоды).
  const chatTools =
    mcp === null
      ? null
      : new CompositeToolSet([
          new LocalImageRecognizingToolSet(mcp.toolSet),
          new LocationToolSet(),
        ]);
  // Перехват Ctrl+V: картинка из буфера → временный файл → плейсхолдер [Image #N] в строку.
  // Контроллер на отправке меняет плейсхолдеры на пути к файлам (их распознаёт агент).
  const paste =
    clipboard === null ? null : installClipboardPaste(input, readlineInterface, clipboard);
  // Активная сессия (команды /branch, /switch, /reset могут её сменить).
  // Полный транскрипт храним в currentSession.messages; в модель уходит окно.
  let currentSession = session;
  // Бюджет истории зависит от контекста выбранной модели и резерва под ответ.
  const historyBudget = historyBudgetTokens(config.contextTokens, limits.maxTokens);
  // При слоистой памяти часть бюджета уходит профилю и задаче, остаток — короткой.
  const budgets = memorySettings.enabled
    ? layerBudgets(
        historyBudget,
        config.contextTokens,
        memorySettings.profileTokens,
        memorySettings.taskTokens,
      )
    : { profile: 0, task: 0, short: historyBudget };
  // Короткая память (окно/сжатие/факты): клиент сжатия — тот же (шов для дешёвой модели).
  const strategy = createMemoryStrategy(
    memory,
    budgets.short,
    keepRecent,
    client,
    config.requestTimeoutMs,
  );
  // Активный профиль (персона): из --profile/указателя, иначе default.
  const activeProfileName = memorySettings.profileName ?? DEFAULT_PROFILE_NAME;
  // Менеджер слоистой памяти поверх короткой стратегии.
  const memoryManager = new MemoryManager({
    enabled: memorySettings.enabled,
    strategy,
    budgets,
    client,
    requestTimeoutMs: config.requestTimeoutMs,
    profile:
      memorySettings.profileStore?.load(activeProfileName) ?? emptyProfile(activeProfileName),
    profileStore: memorySettings.profileStore,
    taskStore: memorySettings.taskStore,
    invariantsStore: memorySettings.invariantsStore ?? null,
  });
  memoryManager.adopt(currentSession.taskId);
  if (memorySettings.initialTaskTitle !== undefined && memoryManager.currentTask() === null) {
    currentSession.taskId = memoryManager.setTask(memorySettings.initialTaskTitle).id;
    store?.save(currentSession);
  }
  // Метка строки доп. вызова короткой памяти: facts обновляет факты, прочие — сжимают.
  const memoryLabel = memory === 'facts' ? 'факты' : 'сжатие';
  // Суммарные токены за всю сессию — для итоговой сводки при выходе.
  const totals: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let requestCount = 0;
  // Печатает строку доп. вызова (сжатие/факты короткой памяти) и копит в итоги.
  const reportExtra = (usage: Usage | undefined, label: string): void => {
    output.write(
      `${formatUsageStats(usage, historyTokens(currentSession.messages), config, label)}\n\n`,
    );
    if (usage !== undefined) {
      totals.prompt_tokens += usage.prompt_tokens;
      totals.completion_tokens += usage.completion_tokens;
      totals.total_tokens += usage.total_tokens;
      requestCount++;
    }
  };
  // Явно показывает, ЧТО и в какой слой записано (с отступом от предыдущей строки),
  // затем строку стоимости вызова; копит токены в итоги.
  const printMemoryWrite = (report: MemoryWriteReport): void => {
    output.write('\n'); // отступ от реплики/ответа
    if (report.consolidated !== null) {
      output.write(`[профиль] консолидировано из ваших реплик: ${report.consolidated} пункт(ов)\n`);
      reportExtra(report.usage, 'профиль');
      return;
    }
    const parts: string[] = [];
    if (report.taskTitle !== null) {
      parts.push(`задача «${report.taskTitle}» ← ${report.taskFactCount} факт(ов)`);
    }
    if (report.profileAdded.length > 0) {
      parts.push(`профиль ← ${report.profileAdded.map(entry => `«${entry}»`).join(', ')}`);
    }
    output.write(`[память] ${parts.length > 0 ? parts.join('; ') : 'без изменений'}\n`);
    reportExtra(report.usage, 'память');
  };

  // Расход токенов текущего прогона (этапы пайплайна) — для сводки по прогону.
  let pipelineUsage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  // Учёт обращений агентов пайплайна/контролёра: в итог сессии и в сводку прогона.
  const accountForAgentUsage = (usage: Usage): void => {
    totals.prompt_tokens += usage.prompt_tokens;
    totals.completion_tokens += usage.completion_tokens;
    totals.total_tokens += usage.total_tokens;
    requestCount++;
    pipelineUsage.prompt_tokens += usage.prompt_tokens;
    pipelineUsage.completion_tokens += usage.completion_tokens;
    pipelineUsage.total_tokens += usage.total_tokens;
  };
  // RAG_QUIET=1 — прятать логи RAG-поиска (вызов + сводку): в grounded-режиме на ход несколько
  // поисков, и они засоряют чат. Ответ с секцией «Источники» при этом остаётся.
  const ragQuiet = process.env.RAG_QUIET === '1';
  // Низкая температура синтеза grounded-ответа/перегенерации гейта (env RAG_ANSWER_TEMPERATURE, 0.2):
  // ответ собирается по фрагментам — точность/достоверность важнее творчества, плюс меньше шума.
  const ragAnswerTemperature = resolveRagAnswerTemperature(process.env.RAG_ANSWER_TEMPERATURE);
  // Печать вызова инструмента агентом (наблюдаемость tool-use). Для распознавания —
  // дружелюбная строка без технического пути; для прочих — имя инструмента и аргументы.
  const reportToolCall = (name: string, args: Record<string, unknown>): void => {
    if (isRecognizeTool(name)) {
      output.write('🔍 Читаю текст с картинок…\n');
      return;
    }
    if (isSearchDocsTool(name) && ragQuiet) {
      return;
    }
    output.write(`🔧 инструмент ${name} ${JSON.stringify(args)}\n`);
  };
  // Результат распознавания показываем СРАЗУ (до остальных шагов пайпа), чтобы выполнить
  // просьбу «распознай и выведи мне» — иначе текст всплыл бы только в финальной сводке хода.
  const reportToolResult = (name: string, result: string): void => {
    if (isRecognizeTool(name)) {
      output.write(`\n📄 Распознанный текст:\n${result}\n`);
      return;
    }
    // Показываем сводку RAG-поиска (трасса стадий + найденные источники), иначе разница между
    // режимами rerank/rewrite/порога видна только модели, а пользователю — нет. RAG_QUIET прячет её.
    if (isSearchDocsTool(name) && !ragQuiet) {
      output.write(`\n🔎 RAG-поиск:\n${formatRagResultForDisplay(result)}\n`);
    }
  };
  // Драйвер прогонов задач (пайплайн): свои диалоги-агенты, своё хранилище.
  // Мост связывает прогон с задачей сессии — память задачи идёт в этапы, итог обратно.
  // Фабрика диалогов-агентов (этапы пайплайна, контролёр инвариантов): своя персона/температура.
  const agentFactory = makeConversationFactory(
    client,
    config,
    disableThinking,
    temperature,
    accountForAgentUsage,
    reportToolCall,
  );
  // Прогон с печатью суммарного расхода токенов прогона (все обращения агентов этапов).
  const runWithUsageReport = async (action: () => Promise<void>): Promise<void> => {
    pipelineUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    await action();
    if (pipelineUsage.total_tokens > 0) {
      output.write(
        `${formatUsageStats(pipelineUsage, historyTokens(currentSession.messages), config, 'прогон')}\n\n`,
      );
    }
  };
  const runController = new RunController({
    store: runStore,
    makeConversation: agentFactory,
    output,
    ask: prompt => readlineInterface.question(prompt),
    taskBridge: new MemoryRunBridge({
      memory: memoryManager,
      session: () => currentSession,
      saveSession: session => store?.save(session),
    }),
    invariants: () => memoryManager.invariantsList(),
    // Инструменты MCP — планировщику и исполнителю (с поддержкой локальных путей).
    tools: chatTools ?? undefined,
    // Constrained decoding этапов — только по явному тумблеру (ломает z.ai/GLM).
    structuredOutputs: config.structuredOutputs,
    // Модель роли выполнения (LLM_EXECUTOR_MODEL); не задана — общая модель.
    executorModel: config.executorModel,
    // Команда агентов на этап: потолок ролей и конкурентность веера из конфига.
    teamConfig: {
      maxAgents: config.maxStageAgents,
      concurrency: config.stageAgentConcurrency,
    },
    // Результаты этапов прогона пишем в транскрипт сессии — видны в истории и идут в контекст.
    recordToSession: (role, content) => {
      currentSession.messages.push({ role, content });
      currentSession.updatedAt = new Date().toISOString();
      store?.save(currentSession);
    },
  });

  // Подключает один MCP-сервер с печатью статуса (сбой не валит остальное).
  const connectMcpServer = async (name: string, serverConfig: McpServerConfig): Promise<void> => {
    try {
      const count = await mcp!.toolSet.addServer(name, serverConfig);
      output.write(`🔌 MCP «${name}» подключён (инструментов: ${count}).\n`);
    } catch (error) {
      output.write(`⚠ MCP «${name}» не подключён: ${describeError(error)}\n`);
    }
  };

  // Команды управления MCP-серверами (доступны только при включённом MCP).
  const listMcp = (): void => {
    if (mcp === null) {
      output.write('MCP выключен (--no-mcp).\n\n');
      return;
    }
    output.write(formatMcpTools(mcp.toolSet.serverNames(), mcp.toolSet.specs()));
  };
  const addMcp = async (rest: string): Promise<void> => {
    if (mcp === null) {
      output.write('MCP выключен (--no-mcp).\n\n');
      return;
    }
    const tokens = rest.split(/\s+/).filter(Boolean);
    const name = tokens[0]; // ввод обрезан и совпал с «/mcp add », поэтому имя есть
    try {
      const serverConfig = parseServerSpec(tokens.slice(1));
      const count = await mcp.toolSet.addServer(name, serverConfig);
      const servers = mcp.store.load();
      servers.set(name, serverConfig);
      mcp.store.save(servers);
      output.write(`MCP «${name}» подключён и сохранён (инструментов: ${count}).\n\n`);
    } catch (error) {
      output.write(`Не удалось добавить MCP-сервер: ${describeError(error)}\n\n`);
    }
  };
  const removeMcp = async (name: string): Promise<void> => {
    if (mcp === null) {
      output.write('MCP выключен (--no-mcp).\n\n');
      return;
    }
    const removed = await mcp.toolSet.removeServer(name);
    if (!removed) {
      output.write(`MCP-сервер не найден: ${name}\n\n`);
      return;
    }
    const servers = mcp.store.load();
    servers.delete(name);
    mcp.store.save(servers);
    output.write(`MCP «${name}» отключён и удалён из конфигурации.\n\n`);
  };
  const reloadMcp = async (): Promise<void> => {
    if (mcp === null) {
      output.write('MCP выключен (--no-mcp).\n\n');
      return;
    }
    await mcp.toolSet.close();
    for (const [name, serverConfig] of mcp.store.load()) {
      await connectMcpServer(name, serverConfig);
    }
    output.write('\n');
  };

  // Создаёт новую задачу, делает её текущей задачей сессии и сразу запускает её
  // исполнение пайплайном (запуск выполнения совмещён с созданием задачи).
  // Установить текущую задачу сессии (память задачи) без исполнения пайплайном.
  const setCurrentTask = (title: string): Task => {
    const task = memoryManager.setTask(title);
    currentSession.taskId = task.id;
    store?.save(currentSession);
    return task;
  };
  const createTaskAndRun = async (title: string): Promise<void> => {
    const task = setCurrentTask(title);
    output.write(`Задача установлена: ${task.title}\n\n`);
    await runWithUsageReport(() => runController.start('')); // прогон текущей задачи сессии
  };

  // Голосовой ввод: запись с микрофона до нажатия Enter → распознавание → текст вставляется в
  // строку ввода для правки перед отправкой. Ошибки записи/распознавания не валят сессию.
  const recordVoice = async (): Promise<void> => {
    if (voice === null) {
      output.write(
        'Голосовой ввод не настроен: задайте YANDEX_API_KEY (опц. YANDEX_FOLDER_ID) и запускайте ' +
          'в терминале.\n\n',
      );
      return;
    }
    const session = voice.recorder.start();
    await readlineInterface.question('🎙 Говорите… (Enter — стоп) ');
    let audio: Uint8Array;
    try {
      audio = await session.finish();
    } catch (error) {
      output.write(`Не удалось записать звук: ${describeError(error)}\n\n`);
      return;
    }
    try {
      const text = await voice.transcribe(audio);
      output.write(`📝 Распознано: ${text}\n`);
      readlineInterface.write(text); // вставляем в строку ввода — можно поправить и отправить
    } catch (error) {
      output.write(`Не удалось распознать речь: ${describeError(error)}\n\n`);
    }
  };

  // Реестр интерактивных команд: первая подходящая по `matches` выполняет `run`.
  // Порядок важен (точные перед префиксными, напр. «/task done» до «/task »).
  // `run` может быть асинхронной (прогон пайплайна) — вызывающий цикл её ожидает.
  const commands: {
    matches: (input: string) => boolean;
    run: (input: string) => void | Promise<void>;
  }[] = [
    { matches: input => input === '/help', run: () => output.write(helpText()) },
    { matches: input => input === '/voice', run: () => recordVoice() },
    { matches: input => input === '/mcp' || input === '/mcp list', run: () => listMcp() },
    { matches: input => input === '/mcp reload', run: () => reloadMcp() },
    {
      matches: input => input.startsWith('/mcp add '),
      run: input => addMcp(input.slice('/mcp add '.length).trim()),
    },
    {
      matches: input => input.startsWith('/mcp remove '),
      run: input => removeMcp(input.slice('/mcp remove '.length).trim()),
    },
    {
      matches: input => input === '/reset',
      run: () => {
        currentSession = newSession(config, limits);
        memoryManager.reset();
        memoryManager.adopt(currentSession.taskId); // новая ветка без задачи
        output.write('Начата новая сессия.\n\n');
      },
    },
    {
      matches: input => input === '/sessions',
      run: () => output.write(store === null ? EPHEMERAL_NOTICE : formatSessionList(store.list())),
    },
    {
      matches: input => input === '/branch' || input.startsWith('/branch '),
      run: input => {
        const name = input.slice('/branch'.length).trim();
        if (store === null) {
          output.write(EPHEMERAL_NOTICE);
        } else if (!name) {
          output.write('Укажите имя ветки: /branch <имя>\n\n');
        } else if (name === currentSession.label || branchNameTaken(store, name)) {
          output.write(`Ветка «${name}» уже существует.\n\n`);
        } else {
          // Checkpoint: сохраняем текущую ветку и ответвляемся от неё в новую.
          const parentTaskId = currentSession.taskId;
          currentSession.updatedAt = new Date().toISOString();
          store.save(currentSession);
          currentSession = createSession(
            currentSession.model,
            [...currentSession.messages],
            undefined,
            undefined,
            name,
          );
          currentSession.taskId = parentTaskId; // ветка наследует задачу
          store.save(currentSession);
          memoryManager.reset();
          memoryManager.adopt(currentSession.taskId);
          output.write(`Создана ветка «${name}» от текущего места, переключились на неё.\n\n`);
        }
      },
    },
    {
      matches: input => input === '/switch' || input.startsWith('/switch '),
      run: input => {
        const arg = input.slice('/switch'.length).trim();
        if (store === null) {
          output.write(EPHEMERAL_NOTICE);
        } else if (!arg) {
          output.write('Укажите имя или id ветки: /switch <имя|id>\n\n');
        } else if (arg === currentSession.label || arg === currentSession.id) {
          output.write(`Уже в ветке «${arg}».\n\n`);
        } else {
          const target = resolveBranch(store, arg);
          if (target === null) {
            output.write(`Ветка не найдена: ${arg}\n\n`);
          } else {
            currentSession.updatedAt = new Date().toISOString();
            store.save(currentSession);
            currentSession = target;
            memoryManager.reset();
            memoryManager.adopt(currentSession.taskId);
            output.write(`Переключились на ветку «${target.label ?? target.id}».\n\n`);
          }
        }
      },
    },
    {
      matches: input => input.startsWith('/system '),
      run: input => {
        // input уже обрезан, поэтому после '/system ' гарантированно есть текст.
        setSystemPrompt(currentSession, input.slice('/system '.length).trim());
        store?.save(currentSession);
        output.write('Системный промпт обновлён.\n\n');
      },
    },
    // Grounded-режим RAG (День 25): привязать источники / показать / выключить. Порядок важен —
    // точные «/rag off» и «/rag» раньше префиксного «/rag ».
    {
      matches: input => input === '/rag off',
      run: () => {
        currentSession.ragSources = undefined;
        store?.save(currentSession);
        output.write('Grounded-режим RAG выключен.\n\n');
      },
    },
    {
      matches: input => input === '/rag',
      run: () => {
        const sources = currentSession.ragSources ?? [];
        output.write(
          sources.length === 0
            ? 'Grounded-режим RAG выключен. Включить: /rag <источник…>\n\n'
            : `Grounded-режим RAG: поиск по источникам на каждом вопросе:\n${sources
                .map(source => `• ${source}`)
                .join('\n')}\n\n`,
        );
      },
    },
    {
      matches: input => input.startsWith('/rag '),
      run: input => {
        // Ввод уже обрезан (trim), поэтому после «/rag » гарантированно есть непустой источник.
        const sources = input.slice('/rag '.length).trim().split(/\s+/);
        currentSession.ragSources = sources;
        store?.save(currentSession);
        output.write(
          `Grounded-режим RAG включён. Источники (${sources.length}):\n${sources
            .map(source => `• ${source}`)
            .join('\n')}\n\n`,
        );
      },
    },
    {
      matches: input => input.startsWith('/file '),
      run: input => {
        const path = input.slice('/file '.length).trim();
        let content: string;
        try {
          content = readFileContent(path);
        } catch (error) {
          output.write(`${describeError(error)}\n\n`);
          return;
        }
        // Содержимое файла кладём в историю как контекст; модель не дёргаем —
        // ответит на следующий вопрос пользователя уже с файлом в контексте.
        const attachment = formatAttachment(path, content);
        currentSession.messages.push({ role: 'user', content: attachment });
        output.write(
          `Файл «${path}» добавлен в контекст (~${estimateTokens(attachment)} токенов).\n\n`,
        );
      },
    },
    {
      matches: input => input.startsWith('/temp '),
      run: input => {
        const parsed = validTemperature(input.slice('/temp '.length).trim());
        if (parsed === null) {
          output.write('Некорректная температура — нужно неотрицательное число.\n\n');
        } else {
          temperature = parsed;
          output.write(`Температура установлена: ${temperature}\n\n`);
        }
      },
    },
    {
      matches: input => input === '/tasks',
      run: () =>
        output.write(
          memoryManager.enabled ? formatTaskList(memoryManager.listTasks()) : MEMORY_OFF_NOTICE,
        ),
    },
    {
      matches: input => input === '/task done',
      run: () => {
        if (!memoryManager.enabled) {
          output.write(MEMORY_OFF_NOTICE);
        } else {
          const closed = memoryManager.closeTask();
          if (closed === null) {
            output.write('Активной задачи нет.\n\n');
          } else {
            currentSession.taskId = undefined;
            store?.save(currentSession);
            output.write(`Задача «${closed}» закрыта.\n\n`);
          }
        }
      },
    },
    {
      matches: input => input.startsWith('/task switch '),
      run: input => {
        const arg = input.slice('/task switch '.length).trim();
        if (!memoryManager.enabled) {
          output.write(MEMORY_OFF_NOTICE);
        } else {
          const task = memoryManager.switchTask(arg);
          if (task === null) {
            output.write(`Задача не найдена: ${arg}\n\n`);
          } else {
            currentSession.taskId = task.id;
            store?.save(currentSession);
            output.write(`Переключились на задачу «${task.title}».\n\n`);
          }
        }
      },
    },
    {
      matches: input => input.startsWith('/task delete '),
      run: input => {
        if (!memoryManager.enabled) {
          output.write(MEMORY_OFF_NOTICE);
        } else {
          const deleted: Task[] = [];
          const notFound: string[] = [];
          for (const token of parseList(input.slice('/task delete '.length))) {
            const removed = memoryManager.deleteTask(token);
            if (removed === null) {
              notFound.push(token);
            } else {
              deleted.push(removed);
              if (currentSession.taskId === removed.id) {
                currentSession.taskId = undefined; // удалили активную — отвязываем сессию
                store?.save(currentSession);
              }
            }
          }
          if (deleted.length === 0) {
            output.write(`Задача не найдена: ${notFound.join(', ')}\n\n`);
          } else {
            const removedNames = deleted.map(task => `«${task.title}»`).join(', ');
            const tail = notFound.length > 0 ? ` Не найдены: ${notFound.join(', ')}.` : '';
            output.write(`Удалено: ${removedNames}.${tail}\n\n`);
          }
        }
      },
    },
    {
      matches: input => input.startsWith('/task '),
      run: async input => {
        if (!memoryManager.enabled) {
          output.write(MEMORY_OFF_NOTICE);
        } else {
          // Установить текущую задачу (память задачи). Исполнение — отдельной командой /run.
          const task = setCurrentTask(input.slice('/task '.length).trim());
          output.write(`Задача установлена: ${task.title}. Исполнить пайплайном — /run.\n\n`);
        }
      },
    },
    {
      matches: input => input === '/task',
      run: () =>
        output.write(
          memoryManager.enabled
            ? formatCurrentTask(memoryManager.currentTask())
            : MEMORY_OFF_NOTICE,
        ),
    },
    { matches: input => input === '/runs', run: () => runController.list() },
    {
      matches: input => input === '/run status' || input.startsWith('/run status '),
      run: input => runController.status(input.slice('/run status'.length).trim() || undefined),
    },
    {
      matches: input => input === '/run continue' || input.startsWith('/run continue '),
      run: input =>
        runWithUsageReport(() =>
          runController.continue(input.slice('/run continue'.length).trim()),
        ),
    },
    {
      matches: input => input.startsWith('/run edit '),
      run: input => runController.edit(input.slice('/run edit '.length).trim()),
    },
    { matches: input => input === '/run abort', run: () => runController.abort() },
    {
      matches: input => input === '/run' || input.startsWith('/run '),
      run: input =>
        runWithUsageReport(() => runController.start(input.slice('/run'.length).trim())),
    },
    {
      matches: input => input === '/invariants',
      run: () =>
        output.write(
          memoryManager.enabled
            ? formatInvariants(memoryManager.invariantsList())
            : MEMORY_OFF_NOTICE,
        ),
    },
    {
      matches: input => input.startsWith('/invariant add '),
      run: input => {
        if (!memoryManager.enabled) {
          output.write(MEMORY_OFF_NOTICE);
        } else {
          const added = memoryManager.addInvariant(input.slice('/invariant add '.length).trim());
          output.write(
            added === null
              ? 'Инвариант пуст или уже задан.\n\n'
              : `Инвариант добавлен: ${added}\n\n`,
          );
        }
      },
    },
    {
      matches: input => input.startsWith('/invariant delete '),
      run: input => {
        if (!memoryManager.enabled) {
          output.write(MEMORY_OFF_NOTICE);
        } else {
          const indices = parseList(input.slice('/invariant delete '.length))
            .map(Number)
            .filter(Number.isInteger);
          const removed = memoryManager.removeInvariants(indices);
          output.write(
            removed.length === 0
              ? 'Нет таких инвариантов.\n\n'
              : `Удалено: ${removed.map(item => `«${item}»`).join(', ')}\n\n`,
          );
        }
      },
    },
    {
      matches: input => input === '/invariant',
      run: () =>
        output.write(
          memoryManager.enabled
            ? formatInvariants(memoryManager.invariantsList())
            : MEMORY_OFF_NOTICE,
        ),
    },
    {
      matches: input => input === '/profiles',
      run: () =>
        output.write(
          memoryManager.enabled
            ? formatProfileList(memoryManager.listProfiles(), memoryManager.currentProfileName())
            : MEMORY_OFF_NOTICE,
        ),
    },
    {
      matches: input => input === '/profile switch' || input.startsWith('/profile switch '),
      run: input => {
        const name = input.slice('/profile switch'.length).trim();
        if (!memoryManager.enabled) {
          output.write(MEMORY_OFF_NOTICE);
        } else if (!name) {
          output.write('Укажите имя профиля: /profile switch <имя>\n\n');
        } else if (name === memoryManager.currentProfileName()) {
          output.write(`Уже на профиле «${name}».\n\n`);
        } else {
          const created = memoryManager.switchProfile(name);
          output.write(
            created
              ? `Создан и активирован профиль «${name}».\n\n`
              : `Активный профиль: «${name}».\n\n`,
          );
        }
      },
    },
    {
      matches: input => input.startsWith('/profile delete '),
      run: input => {
        if (!memoryManager.enabled) {
          output.write(MEMORY_OFF_NOTICE);
        } else {
          const deleted: string[] = [];
          const notFound: string[] = [];
          for (const profileName of parseList(input.slice('/profile delete '.length))) {
            (memoryManager.deleteProfile(profileName) ? deleted : notFound).push(profileName);
          }
          if (deleted.length === 0) {
            output.write(`Профиль не найден: ${notFound.join(', ')}\n\n`);
          } else {
            const removedNames = deleted.map(profileName => `«${profileName}»`).join(', ');
            const tail = notFound.length > 0 ? ` Не найдены: ${notFound.join(', ')}.` : '';
            output.write(
              `Удалено: ${removedNames}.${tail} Активный: «${memoryManager.currentProfileName()}».\n\n`,
            );
          }
        }
      },
    },
    {
      matches: input => input === '/profile rename' || input.startsWith('/profile rename '),
      run: input => {
        const newName = input.slice('/profile rename'.length).trim();
        if (!memoryManager.enabled) {
          output.write(MEMORY_OFF_NOTICE);
        } else if (!newName) {
          output.write('Укажите новое имя: /profile rename <новое имя>\n\n');
        } else {
          const result = memoryManager.renameProfile(newName);
          output.write(
            result === 'taken'
              ? `Профиль «${newName}» уже существует.\n\n`
              : result === 'same'
                ? `Профиль уже называется «${newName}».\n\n`
                : `Профиль переименован в «${newName}».\n\n`,
          );
        }
      },
    },
    {
      matches: input => input.startsWith('/profile forget '),
      run: input => {
        if (!memoryManager.enabled) {
          output.write(MEMORY_OFF_NOTICE);
        } else {
          const indices = parseList(input.slice('/profile forget '.length))
            .map(Number)
            .filter(Number.isInteger);
          const removed = memoryManager.forgetProfile(indices);
          output.write(
            removed.length === 0
              ? 'Нет таких пунктов профиля.\n\n'
              : `Забыто: ${removed.join('; ')}\n\n`,
          );
        }
      },
    },
    {
      matches: input => input === '/profile',
      run: () =>
        output.write(
          memoryManager.enabled
            ? formatProfile(memoryManager.profileEntries(), memoryManager.currentProfileName())
            : MEMORY_OFF_NOTICE,
        ),
    },
  ];

  // Ctrl+C (SIGINT) и закрытие ввода (Ctrl+D / EOF) прерывают ожидание строки:
  // abort заставляет question отклониться, и цикл штатно завершается. Но если идёт
  // прогон пайплайна — Ctrl+C ставит его на паузу (на границе этапа), а не выходит.
  const abortController = new AbortController();
  const requestStop = () => {
    if (runController.isRunning()) {
      runController.requestPause();
    } else {
      abortController.abort();
    }
  };
  readlineInterface.on('SIGINT', requestStop);
  readlineInterface.on('close', requestStop);

  output.write(
    `Чат с моделью «${config.model}» (температура ${temperature}). ` +
      'Сообщение — текст; команды — /help; выход — /exit или Ctrl+C.\n',
  );

  // Подключаем MCP-серверы из конфигурации на старте (сбой одного не мешает остальным).
  if (mcp !== null) {
    for (const [name, serverConfig] of mcp.store.load()) {
      await connectMcpServer(name, serverConfig);
    }
  }

  try {
    while (true) {
      let userInput: string;
      try {
        userInput = (
          await readlineInterface.question('Вы: ', { signal: abortController.signal })
        ).trim();
      } catch {
        // question отклонён из-за Ctrl+C / закрытия ввода — выходим без ошибки.
        break;
      }
      // Плейсхолдеры [Image #N] (вставки Ctrl+V) → пути к временным файлам для этого промпта.
      if (paste !== null) {
        userInput = paste.consume(userInput);
      }
      if (!userInput) continue;
      if (userInput === '/exit' || userInput === '/quit') break;
      const command = commands.find(entry => entry.matches(userInput));
      if (command !== undefined) {
        await command.run(userInput);
        continue;
      }

      currentSession.messages.push({ role: 'user', content: userInput });
      // Сначала наблюдаем (извлечение памяти + детект новой задачи), затем — если
      // предложена новая задача — спрашиваем подтверждение ДО ответа модели, чтобы
      // подтверждённая задача уже попала в контекст этого ответа.
      const writeReport = await memoryManager.observe(currentSession.messages);
      if (writeReport !== null) {
        printMemoryWrite(writeReport);
      }
      const proposed = memoryManager.takeProposal();
      if (proposed !== null) {
        let reply: string;
        try {
          reply = (
            await readlineInterface.question(
              `Похоже на новую задачу. Сделать задачей сессии «${proposed}»? (да/нет) `,
              { signal: abortController.signal },
            )
          )
            .trim()
            .toLowerCase();
        } catch {
          break; // подтверждение прервано (Ctrl+C / EOF) — выходим
        }
        if (isAffirmative(reply)) {
          // Подтверждённая задача сразу исполняется пайплайном — прогон заменяет
          // обычный ответ модели на это сообщение, поэтому переходим к новой строке.
          await createTaskAndRun(proposed);
          continue;
        }
        memoryManager.declineProposal(proposed);
        if (isNegative(reply)) {
          output.write('Хорошо, без задачи.\n\n');
        }
      }
      // Авто-предложение инварианта (если зафиксировано жёсткое ограничение) — до ответа,
      // чтобы подтверждённый инвариант сразу попал в контекст этого хода.
      const proposedInvariant = memoryManager.takeInvariantProposal();
      if (proposedInvariant !== null) {
        let reply: string;
        try {
          reply = (
            await readlineInterface.question(
              `Похоже на жёсткое ограничение. Сделать инвариантом «${proposedInvariant}»? (да/нет) `,
              { signal: abortController.signal },
            )
          )
            .trim()
            .toLowerCase();
        } catch {
          break; // подтверждение прервано (Ctrl+C / EOF) — выходим
        }
        if (isAffirmative(reply)) {
          memoryManager.addInvariant(proposedInvariant);
          output.write(`Инвариант добавлен: ${proposedInvariant}\n\n`);
        } else {
          memoryManager.declineInvariant(proposedInvariant);
          if (isNegative(reply)) {
            output.write('Хорошо, без инварианта.\n\n');
          }
        }
      }
      // Сборка контекста (короткая память + профиль + задача) и ответ.
      const windowed = await memoryManager.build(currentSession.messages, usage =>
        reportExtra(usage, memoryLabel),
      );
      try {
        let usage: Usage | undefined;
        // Один ход генерации (с учётом feedback контролёра при перегенерации).
        const produce = async (feedback?: string): Promise<string> => {
          const outgoing =
            feedback === undefined
              ? windowed
              : [...windowed, { role: 'user' as const, content: feedback }];
          // С подключённым MCP чат идёт агентным циклом (без стрима): доступны инструменты
          // MCP и клиентский get_my_location (набор непуст всегда, когда MCP включён).
          if (chatTools !== null) {
            output.write('\n');
            // Ведущие system-подсказки: текущее время (для относительных сроков) и, если есть
            // recognize-text, директива про распознавание (локальные пути + ответ при неудаче).
            const leading = [
              { role: 'system' as const, content: currentTimeContext(new Date()) },
              { role: 'system' as const, content: TOOL_HONESTY_DIRECTIVE },
            ];
            const directive = recognizeTextDirective(chatTools.specs());
            if (directive !== null) {
              leading.push({ role: 'system' as const, content: directive });
            }
            const groundedSources = currentSession.ragSources ?? [];
            // RAG-директиву (формат Источники/Цитаты + нацеливание на поиск) подмешиваем ТОЛЬКО когда
            // RAG реально уместен: grounded-режим (/rag) ИЛИ источник назван в самом вопросе
            // (github/URL/путь). Иначе подключённый rag-mcp навязывал бы формат КАЖДОМУ ответу (даже
            // «напиши bubble sort») — слабая модель дописывала пустые «Источники:»/«Цитаты:».
            // RAG_ANSWER_COMPACT=1 — компактные источники/цитаты (для длинного чата).
            const ragRelevant = groundedSources.length > 0 || queryMentionsSource(userInput);
            const ragDirective = ragRelevant
              ? ragSearchDirective(chatTools.specs(), process.env.RAG_ANSWER_COMPACT === '1')
              : null;
            if (ragDirective !== null) {
              leading.push({ role: 'system' as const, content: ragDirective });
            }
            // Какие инструменты реально вызваны за этот ход (вкл. принудительный grounded-поиск) —
            // для гейта цитат и проверки «фантомных» заявлений.
            const calledTools: string[] = [];
            // Grounded-режим (День 25): на содержательный вопрос детерминированно ищем по КАЖДОМУ
            // привязанному источнику (запрос обогащён целью/терминами задачи) и кладём фрагменты в
            // контекст. Дальше идёт обычный агентный ход (другие инструменты доступны) + гейт Дня 24.
            const grounded = groundedSources.length > 0 && !isConversationalReply(userInput);
            // Ход-воспоминание (День 25 Этап 3): «напомни/что мы решили…» — сперва пробуем
            // ВОСПРОИЗВЕСТИ прошлый ответ из истории (temp=0, дословно, с «Источниками»), без
            // форс-поиска и цитатного гейта. Не нашлось (сентинел) — молча откатываемся на обычный
            // grounded-поиск ниже (пользователь сентинел не видит). Только на первой генерации хода
            // (не при перегенерации контролёром инвариантов).
            if (
              grounded &&
              feedback === undefined &&
              isRecallTurn(userInput, writeReport?.recall ?? false)
            ) {
              const recalled = await askModel(
                client,
                [{ role: 'system' as const, content: RECALL_SYSTEM_PROMPT }, ...outgoing],
                config.requestTimeoutMs,
                limits,
                disableThinking,
                0,
              );
              if (!isRecallFallback(recalled.content)) {
                usage = recalled.usage;
                output.write(
                  `${ASSISTANT_LABEL}: ${renderMarkdownForTerminal(recalled.content, isTty)}\n\n`,
                );
                return recalled.content;
              }
              // Сентинел — в истории ответа нет; идём на обычный grounded-путь.
            }
            const forcedResults = grounded
              ? await forcedRagSearch(
                  chatTools,
                  groundedSources,
                  buildGroundedQuery(userInput, groundedFocus(memoryManager.currentTask())),
                  (name, args, toolResult) => {
                    calledTools.push(name);
                    reportToolCall(name, args);
                    reportToolResult(name, toolResult);
                  },
                )
              : [];
            // Предохранитель: в grounded форс-поиск ДОЛЖЕН что-то вернуть. Пустой список = инструмент
            // search_docs недоступен (rag-сервер отвалился) — фрагментов нет. НЕ пускаем сырой ответ
            // модели (иначе галлюцинация несуществующих фактов/источников) — фейлимся видимо. Так же
            // это делает корневую причину заметной вместо правдоподобной лжи.
            if (grounded && forcedResults.length === 0) {
              output.write(`${ASSISTANT_LABEL}: ${RAG_SEARCH_UNAVAILABLE}\n\n`);
              return RAG_SEARCH_UNAVAILABLE;
            }
            if (forcedResults.length > 0) {
              leading.push({
                role: 'system' as const,
                content:
                  'Найденные фрагменты по вопросу (отвечай СТРОГО по ним; повторно эти источники не ' +
                  `ищи):\n${forcedResults.join('\n\n')}`,
              });
            }
            const withTools = [...leading, ...outgoing];
            // Результаты search_docs за ход — против них цитатный гейт сверяет дословные цитаты
            // (grounded-режим предзаполняет их принудительным поиском).
            const ragResults: string[] = [...forcedResults];
            // Grounded-ответ — TOOL-FREE: фрагменты уже добыты принудительным поиском, модели остаётся
            // лишь синтезировать ответ по ним. Полный агентный цикл в grounded давал слабой модели
            // «играться» с посторонними инструментами (scheduler и т.п.) — вплоть до ВРЕДНЫХ побочных
            // действий из вопроса про документацию. Перегенерация гейта и так tool-free — делаем первый
            // проход консистентным. Не-grounded (в т.ч. «источник назван в запросе») — агентный цикл.
            const result = grounded
              ? await askModel(
                  client,
                  withTools,
                  config.requestTimeoutMs,
                  limits,
                  disableThinking,
                  ragAnswerTemperature,
                )
              : await completeWithTools(
                  client,
                  withTools,
                  chatTools,
                  config.requestTimeoutMs,
                  limits,
                  disableThinking,
                  temperature,
                  (name, args) => {
                    calledTools.push(name);
                    reportToolCall(name, args);
                  },
                  config.maxToolRounds,
                  (name, toolResult) => {
                    if (isSearchDocsTool(name)) {
                      ragResults.push(toolResult);
                    }
                    reportToolResult(name, toolResult);
                  },
                );
            usage = result.usage;
            // RAG-ход: слабый/пустой контекст → «не знаю»; иначе — гейт дословных цитат и источников
            // (перегенерация при провале, безопасный фолбэк). На не-RAG ходах ответ модели как есть.
            // RAG_FAITHFULNESS_CHECK=1 — опциональный рантайм-судья достоверности поверх локального гейта.
            const faithfulness =
              process.env.RAG_FAITHFULNESS_CHECK === '1'
                ? {
                    makeChecker: () => agentFactory(FAITHFULNESS_CHECKER_SYSTEM, undefined, 0),
                    onUnfaithful: (issues: string[], attempt: number) =>
                      output.write(
                        `↻ достоверность (попытка ${attempt}): ответ не опирается на источники:\n${issues.join('\n')}\n`,
                      ),
                  }
                : undefined;
            const finalContent = calledTools.some(isSearchDocsTool)
              ? await resolveRagAnswer({
                  ragResults,
                  initial: result.content,
                  regenerate: async feedback => {
                    const fix = [
                      ...withTools,
                      {
                        role: 'user' as const,
                        content: `${feedback}\n\nНайденные фрагменты (используй только их):\n${ragResults.join('\n\n')}`,
                      },
                    ];
                    const fixed = await askModel(
                      client,
                      fix,
                      config.requestTimeoutMs,
                      limits,
                      disableThinking,
                      ragAnswerTemperature,
                    );
                    return fixed.content;
                  },
                  onFailure: (reason, attempt) =>
                    output.write(`⚠ Цитаты не подтвердились (попытка ${attempt}): ${reason}\n`),
                  faithfulness,
                })
              : result.content;
            // Трасса вызовов: видно выбор инструментов и порядок маршрутизации по серверам.
            output.write(formatToolTrace(calledTools));
            output.write(
              `${ASSISTANT_LABEL}: ${renderMarkdownForTerminal(finalContent, isTty)}\n\n`,
            );
            // Подстраховка: ассистент заявил действие в планировщике, не вызвав инструмент.
            if (claimsSchedulerActionWithoutCall(finalContent, calledTools)) {
              output.write(
                '⚠ Похоже, ассистент сообщил о действии в планировщике, но инструмент не ' +
                  'вызывался — действие, скорее всего, НЕ выполнено. Проверьте: «покажи задачи».\n\n',
              );
            }
            return finalContent;
          }
          if (stream) {
            // Пустая строка-отступ, чтобы прелоадер/ответ не «прилипали» к строке «Вы: …».
            output.write('\n');
            const result = await streamAnswer(
              client,
              outgoing,
              config.requestTimeoutMs,
              limits,
              disableThinking,
              temperature,
              output,
              () => output.write(`${ASSISTANT_LABEL}: `),
            );
            usage = result.usage;
            output.write('\n\n');
            return result.content;
          }
          const result = await askModel(
            client,
            outgoing,
            config.requestTimeoutMs,
            limits,
            disableThinking,
            temperature,
          );
          usage = result.usage;
          output.write(
            `\n${ASSISTANT_LABEL}: ${renderMarkdownForTerminal(result.content, isTty)}\n\n`,
          );
          return result.content;
        };
        // Жёсткий контроль инвариантов: если их нет — обычная генерация без оверхеда.
        const answer = await enforceInvariants({
          invariants: memoryManager.invariantsList(),
          makeChecker: () => agentFactory(INVARIANT_CHECKER_SYSTEM, undefined, 0),
          produce,
          onViolation: violations =>
            output.write(
              `↻ контролёр: ответ нарушает инварианты, перегенерирую:\n${violations.join('\n')}\n\n`,
            ),
        });
        currentSession.messages.push({ role: 'assistant', content: answer });
        // Сохраняем сессию после завершённого обмена (store=null при --ephemeral).
        currentSession.updatedAt = new Date().toISOString();
        store?.save(currentSession);
        // Статистика по запросу и истории под ответом.
        output.write(
          `${formatUsageStats(usage, historyTokens(currentSession.messages), config)}\n\n`,
        );
        // Накапливаем итог за сессию (если провайдер прислал usage).
        if (usage !== undefined) {
          totals.prompt_tokens += usage.prompt_tokens;
          totals.completion_tokens += usage.completion_tokens;
          totals.total_tokens += usage.total_tokens;
          requestCount++;
        }
      } catch (error) {
        // Откатываем неудачный ход, чтобы история осталась согласованной.
        currentSession.messages.pop();
        if (error instanceof InvariantViolationError) {
          // Контролёр не смог добиться соблюдения — отказываемся (решение не выдаём).
          output.write(
            `\n⛔ Не могу предложить решение: нарушает инвариант(ы):\n${error.violations.join('\n')}\n\n`,
          );
        } else {
          output.write(`\n[ошибка] ${describeError(error)}\n\n`);
        }
      }
    }
    // Консолидация профиля: устойчивые черты пользователя из всей сессии.
    const consolidationReport = await memoryManager.consolidate(currentSession.messages);
    if (consolidationReport !== null) {
      printMemoryWrite(consolidationReport);
    }
    // Итоговая сводка за сессию — только если были запросы с usage.
    if (requestCount > 0) {
      output.write(`\n${formatSessionTotals(totals, config)}\n`);
    }
    output.write('\nДо встречи!\n');
  } finally {
    await mcp?.toolSet.close(); // закрываем все MCP-подключения
    readlineInterface.close();
  }
}
