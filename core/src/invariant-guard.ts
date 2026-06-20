import type { Conversation } from './conversation.ts';
import { extractJsonObject } from './pipeline-stages.ts';

/** Персона агента-контролёра: сверяет ответ агента с инвариантами и называет нарушения. */
export const INVARIANT_CHECKER_SYSTEM =
  'Ты — контролёр инвариантов. Тебе дан список инвариантов (жёсткие ограничения) и ответ ' +
  'другого агента. Инвариант нарушен ТОЛЬКО если ответ реально делает запрещённое. Запрет ' +
  'на X (например, на React) НЕ нарушается использованием ДРУГИХ технологий (Vue, Svelte, ' +
  'нативный JS и т.п.) — это не нарушение. Если нарушения нет или сомневаешься — считай, что ' +
  'нарушения нет. Верни ТОЛЬКО объектом JSON: {"ok": true|false, "violations": ["конкретное ' +
  'нарушение"]}. ok=true, если не нарушен ни один инвариант. В "violations" клади ТОЛЬКО ' +
  'краткие конкретные нарушения — без рассуждений; нет нарушений → ok=true и пустой массив.';

/** Ошибка: инвариант остался нарушен после всех попыток перегенерации. */
export class InvariantViolationError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(`Нарушены инварианты: ${violations.join('; ')}`);
    this.name = 'InvariantViolationError';
    this.violations = violations;
  }
}

/**
 * Разбирает вердикт контролёра: список нарушений (пустой = всё чисто). Неразобранный
 * ответ контролёра трактуем как «нарушений не найдено» (не блокируем при сбое контролёра).
 */
export function parseInvariantCheck(content: string): string[] {
  for (const candidate of [content, extractJsonObject(content)]) {
    if (candidate === null) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate) as { ok?: unknown; violations?: unknown };
      if (parsed.ok === true) {
        return [];
      }
      return Array.isArray(parsed.violations)
        ? parsed.violations.filter((item): item is string => typeof item === 'string')
        : [];
    } catch {
      // пробуем следующий кандидат
    }
  }
  return [];
}

/** Параметры защищённой генерации. */
export interface EnforceInvariantsOptions {
  /** Текущие инварианты; пустой список → контролёр не вызывается (ноль оверхеда). */
  invariants: string[];
  /** Фабрика свежего диалога контролёра (своя персона, низкая температура). */
  makeChecker: () => Conversation;
  /** Генерация ответа агента; feedback — замечания прошлой проверки для перегенерации. */
  produce: (feedback?: string) => Promise<string>;
  /** Сколько перегенераций допустимо при нарушении (по умолчанию 2). */
  maxRegenerations?: number;
  /** Колбэк на найденное нарушение (для печати): названные инварианты + номер попытки. */
  onViolation?: (violations: string[], attempt: number) => void;
}

/** Сверяет ответ агента с инвариантами контролёром (свежий диалог на каждую проверку). */
async function check(
  invariants: string[],
  text: string,
  makeChecker: () => Conversation,
): Promise<string[]> {
  const checker = makeChecker();
  const result = await checker.ask(
    `Инварианты:\n${invariants.map(item => `- ${item}`).join('\n')}\n\n` +
      `Ответ агента на проверку:\n${text}`,
  );
  return parseInvariantCheck(result.content);
}

/**
 * Защищённая генерация: получает ответ агента и сверяет его контролёром с инвариантами.
 * При нарушении называет нарушенные инварианты и заставляет агента перегенерировать
 * (до maxRegenerations раз). Если не сошлось — бросает {@link InvariantViolationError}.
 * Без инвариантов контролёр не вызывается — обычная генерация без оверхеда.
 */
export async function enforceInvariants(options: EnforceInvariantsOptions): Promise<string> {
  const { invariants, makeChecker, produce, maxRegenerations = 2, onViolation } = options;
  let text = await produce();
  if (invariants.length === 0) {
    return text; // инвариантов нет — контролёр не нужен
  }
  let violations: string[] = [];
  // Первая проверка + до maxRegenerations перегенераций.
  for (let attempt = 0; attempt <= maxRegenerations; attempt++) {
    violations = await check(invariants, text, makeChecker);
    if (violations.length === 0) {
      return text; // чисто
    }
    onViolation?.(violations, attempt + 1);
    if (attempt < maxRegenerations) {
      text = await produce(
        `Твой ответ нарушает инварианты:\n${violations.join('\n')}\n` +
          'Перегенерируй ответ, строго соблюдая ВСЕ инварианты. Сохрани тот же формат и ' +
          'полноту ответа (все обязательные поля/разделы); измени только нарушающее инвариант.',
      );
    }
  }
  // Попытки исчерпаны — называем нарушения и останавливаемся.
  throw new InvariantViolationError(violations);
}
