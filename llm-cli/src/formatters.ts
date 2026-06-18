import type { ProfileSummary, SessionSummary, Task, TaskSummary } from '../../core/src/index.ts';

/** Сообщение, когда сессионные команды вызваны при отключённом хранилище. */
export const EPHEMERAL_NOTICE = 'Хранилище сессий отключено (--ephemeral).\n\n';

/** Сообщение, когда команды памяти вызваны при выключенной слоистой памяти. */
export const MEMORY_OFF_NOTICE = 'Слоистая память выключена (--no-memory).\n\n';

/** Форматирует список задач для команды /tasks. */
export function formatTaskList(summaries: TaskSummary[]): string {
  if (summaries.length === 0) {
    return 'Задач пока нет.\n\n';
  }
  const lines = summaries.map(summary => {
    const mark = summary.status === 'done' ? '✓' : '•';
    return `  ${mark} ${summary.title}  (${summary.id})  фактов: ${summary.detailCount}`;
  });
  return `Задачи:\n${lines.join('\n')}\n\n`;
}

/** Форматирует текущую задачу (с деталями) для команды /task. */
export function formatCurrentTask(task: Task | null): string {
  if (task === null) {
    return 'Активной задачи нет. Задать: /task <описание>\n\n';
  }
  const details =
    task.details.length > 0
      ? task.details.map(detail => `  - ${detail}`).join('\n')
      : '  (пока без деталей)';
  return `Текущая задача: ${task.title}\n${details}\n\n`;
}

/** Форматирует профиль пользователя (нумерованно) для команды /profile. */
export function formatProfile(entries: string[], activeName: string): string {
  const header = `Профиль «${activeName}»`;
  if (entries.length === 0) {
    return `${header}: пуст — пока ничего не знаю о ваших предпочтениях.\n\n`;
  }
  const lines = entries.map((entry, index) => `  ${index + 1}. ${entry}`);
  return `${header}:\n${lines.join('\n')}\n\n`;
}

/** Форматирует список профилей (с пометкой активного) для команды /profiles. */
export function formatProfileList(summaries: ProfileSummary[], activeName: string): string {
  // Активный профиль показываем всегда, даже если он ещё пуст и не сохранён.
  const names = summaries.map(summary => summary.name);
  const rows = names.includes(activeName)
    ? summaries
    : [{ name: activeName, entryCount: 0, updatedAt: '' }, ...summaries];
  const lines = rows.map(summary => {
    const mark = summary.name === activeName ? '*' : ' ';
    return ` ${mark} ${summary.name}  (пунктов: ${summary.entryCount})`;
  });
  return `Профили:\n${lines.join('\n')}\n\n`;
}

/** Текст справки по интерактивным командам. */
export function helpText(): string {
  return (
    'Команды:\n' +
    '  /help               — этот список\n' +
    '  /sessions           — ветки (сохранённые сессии)\n' +
    '  /branch <имя>       — ответвиться в новую ветку с именем\n' +
    '  /switch <имя|id>    — переключиться на ветку\n' +
    '  /reset              — начать новую пустую ветку\n' +
    '  /task [текст]       — показать или задать текущую задачу\n' +
    '  /tasks              — список задач\n' +
    '  /task switch <id|имя> — переключиться на задачу\n' +
    '  /task done          — закрыть текущую задачу\n' +
    '  /task delete <id|имя,…> — удалить задачу(и)\n' +
    '  /profile            — что известно о вас (активный профиль)\n' +
    '  /profiles           — список профилей (персон)\n' +
    '  /profile switch <имя> — переключить/создать профиль\n' +
    '  /profile rename <имя> — переименовать активный профиль\n' +
    '  /profile delete <имя,…> — удалить профиль(и)\n' +
    '  /profile forget <n,…> — забыть пункт(ы) профиля\n' +
    '  /system <текст>     — изменить системный промпт\n' +
    '  /file <путь>        — добавить содержимое файла в контекст\n' +
    '  /temp <число>       — изменить температуру\n' +
    '  /exit, /quit        — выход\n\n'
  );
}

/** Форматирует список веток (сессий) для команды /sessions. */
export function formatSessionList(summaries: SessionSummary[]): string {
  if (summaries.length === 0) {
    return 'Сохранённых веток нет.\n\n';
  }
  const lines = summaries.map(
    summary => `  ${summary.label ?? '—'}  (${summary.id})  ${summary.preview || '(пусто)'}`,
  );
  return `Ветки:\n${lines.join('\n')}\n\n`;
}
