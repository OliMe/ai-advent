import type { DiffFile } from './diff.ts';
import type { Finding } from './schema.ts';

/** Разделённые находки: инлайн-годные (легли на реальную строку) и общие (в сводку). */
export interface ValidatedFindings {
  /** Находки, чей (файл, строка) реально комментируем в diff. */
  inline: Finding[];
  /** Находки, не легшие на комментируемую строку — идут в сводный комментарий, а не выдумываются. */
  general: Finding[];
}

/**
 * Делит находки на инлайн-годные и общие. Инлайн-годна, только если `file` есть среди изменённых
 * файлов И `line` входит в его `commentableLines`. Это детерминированный предохранитель от
 * галлюцинаций: замечание НЕ ставится у несуществующей/некомментируемой строки, а уходит в сводку.
 * Так ревью не выдумывает координаты (аналог принципа цитатного гейта Дня 24, но под формат находок).
 */
export function validateFindings(findings: Finding[], files: DiffFile[]): ValidatedFindings {
  const byPath = new Map(files.map(file => [file.path, file.commentableLines]));
  const inline: Finding[] = [];
  const general: Finding[] = [];
  for (const finding of findings) {
    const commentable = byPath.get(finding.file);
    if (commentable !== undefined && commentable.has(finding.line)) {
      inline.push(finding);
    } else {
      general.push(finding);
    }
  }
  return { inline, general };
}
