import { SEVERITY_ORDER } from './schema.ts';
import type { Finding, FindingSeverity } from './schema.ts';
import type { ValidatedFindings } from './validate.ts';

/** Ранг важности: 0 — самая серьёзная (bug), больше — менее (nitpick). */
export function severityRank(severity: FindingSeverity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/** Проходит ли находка порог важности (её категория не ниже минимальной). */
export function meetsSeverity(severity: FindingSeverity, min: FindingSeverity): boolean {
  return severityRank(severity) <= severityRank(min);
}

/**
 * Дедуп находок по паре (файл, строка): на одной строке — один комментарий. Из совпавших
 * оставляем самую серьёзную (наименьший ранг); порядок первого появления сохраняется, чтобы вывод
 * был стабильным. Слабая модель нередко дублирует замечание — иначе на строке было бы несколько.
 */
export function dedupeFindings(findings: Finding[]): Finding[] {
  const byKey = new Map<string, number>(); // ключ → индекс в result
  const result: Finding[] = [];
  for (const finding of findings) {
    const key = `${finding.file}:${finding.line}`;
    const existingIndex = byKey.get(key);
    if (existingIndex === undefined) {
      byKey.set(key, result.length);
      result.push(finding);
    } else if (severityRank(finding.severity) < severityRank(result[existingIndex].severity)) {
      result[existingIndex] = finding; // более серьёзная вытесняет прежнюю на той же строке
    }
  }
  return result;
}

/** Параметры пост-обработки инлайн-находок. */
export interface PostprocessOptions {
  /** Минимальная категория для ИНЛАЙНА; ниже — в сводку. */
  minSeverity: FindingSeverity;
  /** Потолок числа инлайн-комментариев; лишнее — в сводку. */
  maxInline: number;
}

/**
 * Готовит находки к публикации: дедуп по строке → порог важности (ниже минимума → в сводку) →
 * лимит инлайна (сверх потолка → в сводку). Общие находки (не легшие на строку из `validate`)
 * добавляются к сводочным. Инлайн отсортирован по важности (серьёзное выше) — при лимите первыми
 * остаются самые важные. Так PR не заваливается шумом, а мелочи не теряются — они в сводке.
 */
export function postprocessFindings(
  validated: ValidatedFindings,
  options: PostprocessOptions,
): ValidatedFindings {
  const deduped = dedupeFindings(validated.inline);
  const passing: Finding[] = [];
  const demoted: Finding[] = [];
  for (const finding of deduped) {
    (meetsSeverity(finding.severity, options.minSeverity) ? passing : demoted).push(finding);
  }
  passing.sort((first, second) => severityRank(first.severity) - severityRank(second.severity));
  const inline = passing.slice(0, options.maxInline);
  const overflow = passing.slice(options.maxInline);
  return { inline, general: [...validated.general, ...demoted, ...overflow] };
}
