/**
 * Runtime-обвязка движка: сборка планировщика с реальными зависимостями (fetch, системные
 * часы, crypto-идентификаторы, LLM-агент через core.Conversation, доставка в Telegram) и
 * фоновый тик. Только проводка к платформе — файл исключён из покрытия (логика — в
 * scheduler/executors/schedule/task-store/builtin-tools/weather/telegram).
 */
import { randomBytes } from 'node:crypto';
import { ChatCompletionClient, Conversation, loadConfig } from '../../core/src/index.ts';
import { FileTaskStore } from './task-store.ts';
import { makeExecutors, type AgentRunner } from './executors.ts';
import { BuiltinToolSet } from './builtin-tools.ts';
import { loadTelegramConfig, sendTelegramMessage } from './telegram.ts';
import { Scheduler, type DeliverFn } from './scheduler.ts';

/** Системный промпт server-side агента-исполнителя. */
const AGENT_EXECUTOR_SYSTEM =
  'Ты — фоновый агент-исполнитель планировщика. Выполни инструкцию пользователя и верни ' +
  'конкретный полезный результат на русском. Если нужны внешние данные (погода, веб-страница) — ' +
  'вызови доступный инструмент (get_weather по координатам, http_get по URL), не выдумывай. ' +
  'Будь краток и по делу.';

/** Собирает LLM-раннера из окружения; нет креденшелов LLM (LLM_*) → undefined. */
function tryLoadAgentRunner(): AgentRunner | undefined {
  let config;
  try {
    config = loadConfig();
  } catch {
    return undefined; // LLM не настроен — kind=agent будет сообщать об этом
  }
  const client = new ChatCompletionClient(config);
  const tools = new BuiltinToolSet((url, init) => fetch(url, init));
  return {
    run: async instruction => {
      const conversation = new Conversation(client, {
        systemPrompt: AGENT_EXECUTOR_SYSTEM,
        temperature: config.temperature,
        contextTokens: config.contextTokens,
        requestTimeoutMs: config.requestTimeoutMs,
        tools,
      });
      const result = await conversation.ask(instruction);
      return result.content;
    },
  };
}

/** Доставка в Telegram, если настроена (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID). */
function tryBuildDeliver(): DeliverFn | undefined {
  const telegram = loadTelegramConfig(process.env);
  if (telegram === undefined) {
    return undefined;
  }
  return async (run, task) => {
    if (task.deliver !== 'telegram') {
      return;
    }
    const body = typeof run.details.text === 'string' ? `\n\n${run.details.text}` : '';
    const message = `🗓 ${task.title}\n${run.summary}${body}`;
    await sendTelegramMessage(telegram, message, (url, init) => fetch(url, init));
  };
}

/** Создаёт планировщик с файловым хранилищем и реальными зависимостями. */
export function createDefaultScheduler(storePath: string): Scheduler {
  const store = new FileTaskStore(storePath);
  const executors = makeExecutors({
    fetchFn: (url, init) => fetch(url, init),
    now: () => Date.now(),
    agentRunner: tryLoadAgentRunner(),
  });
  return new Scheduler({
    store,
    executors,
    now: () => Date.now(),
    idFactory: () => randomBytes(6).toString('hex'),
    deliver: tryBuildDeliver(),
  });
}

/** Запускает фоновый тик; пропускает запуск, если предыдущий ещё идёт. */
export function startTicking(scheduler: Scheduler, intervalMs: number): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    void scheduler.tick().finally(() => {
      running = false;
    });
  }, intervalMs);
}
