import type { ToolSet } from '../../core/src/index.ts';

/** Один результат запуска из инбокса планировщика (для уведомлений). */
export interface PolledRun {
  firedAt: string;
  taskTitle: string;
  ok: boolean;
  text: string;
}

/** Суффикс имени инструмента поллинга (с учётом неймспейса «сервер__poll_results»). */
const POLL_TOOL_SUFFIX = 'poll_results';

/** Имя инструмента poll_results среди доступных или null. */
export function findPollTool(toolSet: ToolSet): string | null {
  const spec = toolSet.specs().find(entry => entry.name.endsWith(POLL_TOOL_SUFFIX));
  return spec === undefined ? null : spec.name;
}

/**
 * Имена серверов (префикс неймспейса «сервер__инструмент»), у которых есть poll_results.
 * Наблюдателю нужны только они — остальные подключения можно закрыть, чтобы не держать лишние.
 */
export function pollServerNames(toolSet: ToolSet): string[] {
  const names = new Set<string>();
  for (const spec of toolSet.specs()) {
    const separator = spec.name.indexOf('__');
    if (separator !== -1 && spec.name.endsWith(POLL_TOOL_SUFFIX)) {
      names.add(spec.name.slice(0, separator));
    }
  }
  return [...names];
}

/** Похоже ли значение на корректный результат запуска. */
function isPolledRun(value: unknown): value is PolledRun {
  const candidate = value as Partial<PolledRun> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.firedAt === 'string' &&
    typeof candidate.taskTitle === 'string' &&
    typeof candidate.ok === 'boolean' &&
    typeof candidate.text === 'string'
  );
}

/** Разбирает JSON-ответ poll_results в массив запусков (битый ввод → пусто). */
function parsePolled(raw: string): PolledRun[] {
  try {
    const data = JSON.parse(raw) as { runs?: unknown };
    return Array.isArray(data.runs) ? data.runs.filter(isPolledRun) : [];
  } catch {
    return [];
  }
}

/**
 * Опрашивает планировщик о запусках новее курсора (ISO firedAt). Возвращает новые запуски
 * (в хронологическом порядке) и обновлённый курсор (firedAt последнего, иначе прежний).
 * Нет инструмента poll_results — пусто и курсор без изменений.
 */
export async function pollNewResults(
  toolSet: ToolSet,
  since: string,
): Promise<{ runs: PolledRun[]; cursor: string }> {
  const tool = findPollTool(toolSet);
  if (tool === null) {
    return { runs: [], cursor: since };
  }
  const runs = parsePolled(await toolSet.call(tool, { since }));
  const cursor = runs.length > 0 ? runs[runs.length - 1].firedAt : since;
  return { runs, cursor };
}
