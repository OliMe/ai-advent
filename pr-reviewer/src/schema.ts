import type { JsonSchemaSpec } from '../../core/src/index.ts';

/** Категория находки ревью. */
export type FindingSeverity = 'bug' | 'architecture' | 'recommendation' | 'nitpick';

/** Одна находка ревью: где (файл+строка), какой категории и что не так. */
export interface Finding {
  /** Путь к файлу (как в diff, новая версия). */
  file: string;
  /** Строка в новой версии файла, к которой относится замечание. */
  line: number;
  severity: FindingSeverity;
  /** Короткий заголовок. */
  title: string;
  /** Пояснение и рекомендация. */
  body: string;
}

/** Разобранный результат ревью: находки + сводка. */
export interface ReviewResult {
  findings: Finding[];
  summary: string;
}

/** Порядок категорий по важности — для сортировки и отчётов. */
export const SEVERITY_ORDER: FindingSeverity[] = [
  'bug',
  'architecture',
  'recommendation',
  'nitpick',
];

/**
 * JSON-схема ответа ревью. Обёртка-объект на верхнем уровне (json_schema требует объект). Строгая
 * (`additionalProperties:false`, все `required`), совместима с constrained decoding Ollama; на
 * z.ai/GLM применяется только промптом (толерантный парсер вынимает объект).
 */
export const REVIEW_SCHEMA: JsonSchemaSpec = {
  name: 'pr_review',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file: { type: 'string' },
            line: { type: 'integer' },
            severity: { type: 'string', enum: SEVERITY_ORDER },
            title: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['file', 'line', 'severity', 'title', 'body'],
        },
      },
      summary: { type: 'string' },
    },
    required: ['findings', 'summary'],
  },
};

/** Строка из аргумента или '' (для мягкого разбора ответа модели). */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Целое из значения или null (номер строки обязан быть настоящим числом). */
function asLine(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/** Категория из значения; неизвестное → 'recommendation' (не теряем находку из-за опечатки модели). */
function asSeverity(value: unknown): FindingSeverity {
  return SEVERITY_ORDER.includes(value as FindingSeverity)
    ? (value as FindingSeverity)
    : 'recommendation';
}

/**
 * Приводит разобранный объект к `ReviewResult`, толерантно к слабой модели: пропускает записи без
 * файла/строки/текста (у них нет якоря для инлайн-комментария), незнакомую категорию сводит к
 * рекомендации. Не массив `findings` → пустой список.
 */
export function coerceReviewResult(parsed: Record<string, unknown>): ReviewResult {
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const findings: Finding[] = [];
  for (const raw of rawFindings) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const file = asString(record.file);
    const line = asLine(record.line);
    const title = asString(record.title);
    const body = asString(record.body);
    if (file === '' || line === null || (title === '' && body === '')) {
      continue;
    }
    findings.push({ file, line, severity: asSeverity(record.severity), title, body });
  }
  return { findings, summary: asString(parsed.summary) };
}
