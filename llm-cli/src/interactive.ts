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
} from '../../core/src/index.ts';
import type {
  AppConfig,
  ChatCompletionClient,
  GenerationLimits,
  ProfileStore,
  RunStore,
  Session,
  SessionStore,
  Task,
  TaskStore,
  Usage,
  MemoryKind,
  MemoryWriteReport,
} from '../../core/src/index.ts';
import { askModel, streamAnswer } from './chat.ts';
import { newSession, branchNameTaken, resolveBranch } from './session-flow.ts';
import { makeConversationFactory, RunController } from './run-flow.ts';
import { MemoryRunBridge } from './run-task-bridge.ts';
import { parseList, isAffirmative, isNegative } from './replies.ts';
import {
  helpText,
  formatSessionList,
  formatTaskList,
  formatCurrentTask,
  formatProfile,
  formatProfileList,
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
): Promise<void> {
  const readlineInterface = createInterface({ input, output });
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

  // Драйвер прогонов задач (пайплайн): свои диалоги-агенты, своё хранилище.
  // Мост связывает прогон с задачей сессии — память задачи идёт в этапы, итог обратно.
  const runController = new RunController({
    store: runStore,
    makeConversation: makeConversationFactory(client, config, disableThinking, temperature),
    output,
    ask: prompt => readlineInterface.question(prompt),
    taskBridge: new MemoryRunBridge({
      memory: memoryManager,
      session: () => currentSession,
      saveSession: session => store?.save(session),
    }),
    // Результаты этапов прогона пишем в транскрипт сессии — видны в истории и идут в контекст.
    recordToSession: (role, content) => {
      currentSession.messages.push({ role, content });
      currentSession.updatedAt = new Date().toISOString();
      store?.save(currentSession);
    },
  });

  // Создаёт новую задачу, делает её текущей задачей сессии и сразу запускает её
  // исполнение пайплайном (запуск выполнения совмещён с созданием задачи).
  const createTaskAndRun = async (title: string): Promise<void> => {
    const task = memoryManager.setTask(title);
    currentSession.taskId = task.id;
    store?.save(currentSession);
    output.write(`Задача установлена: ${task.title}\n\n`);
    await runController.start(''); // прогон текущей задачи сессии
  };

  // Реестр интерактивных команд: первая подходящая по `matches` выполняет `run`.
  // Порядок важен (точные перед префиксными, напр. «/task done» до «/task »).
  // `run` может быть асинхронной (прогон пайплайна) — вызывающий цикл её ожидает.
  const commands: {
    matches: (input: string) => boolean;
    run: (input: string) => void | Promise<void>;
  }[] = [
    { matches: input => input === '/help', run: () => output.write(helpText()) },
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
          // Новая задача сразу исполняется пайплайном.
          await createTaskAndRun(input.slice('/task '.length).trim());
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
      run: input => runController.continue(input.slice('/run continue'.length).trim()),
    },
    {
      matches: input => input.startsWith('/run edit '),
      run: input => runController.edit(input.slice('/run edit '.length).trim()),
    },
    { matches: input => input === '/run abort', run: () => runController.abort() },
    {
      matches: input => input === '/run' || input.startsWith('/run '),
      run: input => runController.start(input.slice('/run'.length).trim()),
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
      // Сборка контекста (короткая память + профиль + задача) и ответ.
      const windowed = await memoryManager.build(currentSession.messages, usage =>
        reportExtra(usage, memoryLabel),
      );
      try {
        let answer: string;
        let usage: Usage | undefined;
        if (stream) {
          // Пустая строка-отступ, чтобы прелоадер/ответ не «прилипали» к строке «Вы: …».
          output.write('\n');
          const result = await streamAnswer(
            client,
            windowed,
            config.requestTimeoutMs,
            limits,
            disableThinking,
            temperature,
            output,
            () => output.write(`${ASSISTANT_LABEL}: `),
          );
          answer = result.content;
          usage = result.usage;
          output.write('\n\n');
        } else {
          const result = await askModel(
            client,
            windowed,
            config.requestTimeoutMs,
            limits,
            disableThinking,
            temperature,
          );
          answer = result.content;
          usage = result.usage;
          output.write(`\n${ASSISTANT_LABEL}: ${answer}\n\n`);
        }
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
        output.write(`\n[ошибка] ${describeError(error)}\n\n`);
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
    readlineInterface.close();
  }
}
