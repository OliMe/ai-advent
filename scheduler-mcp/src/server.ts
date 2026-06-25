/**
 * Сборка MCP-сервера планировщика: регистрирует инструменты управления задачами и связывает их
 * с движком. Только проводка к SDK — логика в scheduler/tools, поэтому файл исключён из покрытия.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Schedule } from './types.ts';
import type { Scheduler } from './scheduler.ts';
import {
  handleScheduleTask,
  handleListTasks,
  handleGetTask,
  handleCancelTask,
  handlePauseTask,
  handleResumeTask,
  handleRunNow,
  handleGetHistory,
  handlePollResults,
} from './tools.ts';

/** Оборачивает текст в ответ MCP-инструмента. */
function text(value: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: value }] };
}

/** Сырой shape расписания для входной схемы инструмента. */
const scheduleShape = {
  type: z.enum(['interval', 'daily', 'once']),
  everySeconds: z.number().optional(),
  at: z.string().optional(),
  tzOffsetMinutes: z.number().optional(),
  atIso: z.string().optional(),
};

/** Приводит разобранное расписание к union-типу Schedule (валидацию делает движок). */
function toSchedule(parsed: {
  type: 'interval' | 'daily' | 'once';
  everySeconds?: number;
  at?: string;
  tzOffsetMinutes?: number;
  atIso?: string;
}): Schedule {
  if (parsed.type === 'interval') {
    return { type: 'interval', everySeconds: parsed.everySeconds ?? 0 };
  }
  if (parsed.type === 'daily') {
    return { type: 'daily', at: parsed.at ?? '', tzOffsetMinutes: parsed.tzOffsetMinutes ?? 0 };
  }
  return { type: 'once', atIso: parsed.atIso ?? '' };
}

/** Создаёт MCP-сервер планировщика, привязанный к переданному движку. */
export function createServer(scheduler: Scheduler): McpServer {
  const server = new McpServer({ name: 'scheduler-mcp', version: '1.0.0' });

  server.registerTool(
    'schedule_task',
    {
      title: 'Запланировать задачу',
      description:
        'Создаёт фоновую задачу. kind: "http_check" (нужен url — пинговать и мерить доступность); ' +
        '"note" (нужен text — заметка/напоминание); "agent" (нужна instruction — инструкция на ' +
        'естественном языке, её исполнит LLM на сервере с инструментами get_weather/http_get; ' +
        'координаты для погоды передавай прямо в instruction). schedule: {type:"interval",everySeconds} ' +
        '| {type:"daily",at:"HH:MM",tzOffsetMinutes} | {type:"once",atIso:"ISO"}. tzOffsetMinutes — ' +
        'смещение пояса в минутах (GMT+5 = 300). deliver:"telegram" — присылать результат в Telegram. ' +
        'Ещё виды: "system_metrics" (снимок метрик VPS; опц. url — доступность/латентность; опц. ' +
        'metricsUrl — эндпоинт счётчика, напр. https://smartnfree.ru/metrics, число запросов); ' +
        '"report" (нужен targetTaskId — агрегирует историю задачи-сборщика метрик в сводку).',
      inputSchema: {
        title: z.string(),
        kind: z.enum(['http_check', 'note', 'agent', 'system_metrics', 'report']),
        url: z.string().optional(),
        metricsUrl: z.string().optional(),
        text: z.string().optional(),
        instruction: z.string().optional(),
        targetTaskId: z.string().optional(),
        deliver: z.enum(['inbox', 'telegram']).optional(),
        schedule: z.object(scheduleShape),
      },
    },
    async args =>
      text(
        handleScheduleTask(scheduler, {
          title: args.title,
          kind: args.kind,
          url: args.url,
          metricsUrl: args.metricsUrl,
          text: args.text,
          instruction: args.instruction,
          targetTaskId: args.targetTaskId,
          deliver: args.deliver,
          schedule: toSchedule(args.schedule),
        }),
      ),
  );

  server.registerTool(
    'list_tasks',
    {
      title: 'Список задач',
      description: 'Перечисляет все задачи со статусом и следующим запуском.',
      inputSchema: {},
    },
    async () => text(handleListTasks(scheduler)),
  );

  server.registerTool(
    'get_task',
    {
      title: 'Задача',
      description: 'Подробности задачи и её последние запуски.',
      inputSchema: { id: z.string() },
    },
    async args => text(handleGetTask(scheduler, args.id)),
  );

  server.registerTool(
    'cancel_task',
    {
      title: 'Удалить задачу',
      description: 'Удаляет задачу (история запусков сохраняется).',
      inputSchema: { id: z.string() },
    },
    async args => text(handleCancelTask(scheduler, args.id)),
  );

  server.registerTool(
    'pause_task',
    {
      title: 'Пауза задачи',
      description: 'Ставит задачу на паузу (срабатывания пропускаются).',
      inputSchema: { id: z.string() },
    },
    async args => text(handlePauseTask(scheduler, args.id)),
  );

  server.registerTool(
    'resume_task',
    {
      title: 'Возобновить задачу',
      description: 'Снимает задачу с паузы и пересчитывает ближайший запуск.',
      inputSchema: { id: z.string() },
    },
    async args => text(handleResumeTask(scheduler, args.id)),
  );

  server.registerTool(
    'run_now',
    {
      title: 'Выполнить сейчас',
      description: 'Запускает задачу немедленно, не меняя расписание.',
      inputSchema: { id: z.string() },
    },
    async args => text(await handleRunNow(scheduler, args.id)),
  );

  server.registerTool(
    'get_history',
    {
      title: 'История запусков',
      description: 'Возвращает результаты запусков (инбокс), новые первыми. Опц. taskId и limit.',
      inputSchema: { taskId: z.string().optional(), limit: z.number().optional() },
    },
    async args => text(handleGetHistory(scheduler, { taskId: args.taskId, limit: args.limit })),
  );

  server.registerTool(
    'poll_results',
    {
      title: 'Новые результаты',
      description:
        'Для клиента-поллера: JSON с запусками новее курсора (since, ISO firedAt). Без since — все. ' +
        'Используется для системных уведомлений, а не для чтения человеком.',
      inputSchema: { since: z.string().optional() },
    },
    async args => text(handlePollResults(scheduler, { since: args.since })),
  );

  return server;
}
