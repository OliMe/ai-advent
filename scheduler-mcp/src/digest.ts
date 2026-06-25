import type { Task } from './types.ts';
import { describeSchedule } from './tools.ts';

/**
 * Дайджест незакрытых «обещаний» — активных задач-напоминаний (kind=note): что обещано и
 * когда ближайшее срабатывание. Прочие виды задач (метрики/отчёты/проверки) не включаются.
 */
export function formatPromisesDigest(tasks: Task[]): string {
  const promises = tasks.filter(task => task.kind === 'note' && task.status === 'active');
  if (promises.length === 0) {
    return 'Незакрытых обещаний нет. 🎉';
  }
  const lines = promises.map(
    task =>
      `• ${task.text ?? task.title} — ${describeSchedule(task.schedule)}; ближайшее: ${task.nextFireAt ?? '—'}`,
  );
  return `📋 Незакрытые обещания (${promises.length}):\n${lines.join('\n')}`;
}
