import type { Conversation } from './conversation.ts';
import type { GenerationLimits } from './types.ts';
import type {
  CompletionArtifact,
  ExecutionArtifact,
  PlanningArtifact,
  TaskRun,
  VerificationArtifact,
} from './task-run.ts';

/** Контекст этапа: всё, что нужно раннеру для одного прогона этапа. */
export interface StageContext {
  run: TaskRun;
  /** Фабрика диалога для агента этапа (свой системный промпт, ограничения и температура). */
  makeConversation: (
    systemPrompt: string,
    limits?: GenerationLimits,
    temperature?: number,
  ) => Conversation;
  /** Пишет файл-артефакт прогона; null — хранилище отключено (--ephemeral). */
  writeArtifact: (name: string, content: string) => string | null;
  /**
   * Память задачи (детали + профиль) для подмешивания в планирование/выполнение.
   * Провайдер (а не строка): требования, собранные на этапе requirements, сразу
   * видны последующим этапам. Пусто — контекста нет.
   */
  memoryContext: () => string;
}

// --- Ленивый разбор: JSON просим в промпте (без response_format, иначе z.ai/GLM
// вырезает литерал «json» из ответа). Парсер устойчив к обёртке прозой. ---

/** Извлекает первый сбалансированный объект `{…}` из текста (учёт строк и экранирования). */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
    } else if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth++;
    } else if (character === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null; // незакрытый объект
}

/** Парсит JSON-объект из ответа: целиком, иначе первый блок `{…}` в прозе; иначе null. */
function parseObject(content: string): Record<string, unknown> | null {
  for (const candidate of [content, extractJsonObject(content)]) {
    if (candidate === null) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // пробуем следующий кандидат
    }
  }
  return null;
}

/** Массив строк из значения (иначе пустой). */
function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

/** Строка из значения (иначе пустая). */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Извлекает пункты-буллеты из текста (строки вида «- …», «* …», «1. …»). */
function extractBullets(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^(?:[-*]|\d+[.)])\s+/.test(line))
    .map(line => line.replace(/^(?:[-*]|\d+[.)])\s+/, '').trim())
    .filter(line => line.length > 0);
}

/** Разбирает артефакт планирования (C → фолбэк на текст/буллеты). */
export function parsePlanning(content: string): PlanningArtifact {
  const object = parseObject(content);
  if (object !== null) {
    return {
      steps: asStrings(object.steps),
      criteria: asStrings(object.criteria),
      text: asString(object.text) || content,
    };
  }
  return { steps: extractBullets(content), criteria: [], text: content };
}

/** Снимает обрамляющее markdown-ограждение (```lang … ```), если весь текст — один блок. */
function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return match === null ? trimmed : match[1];
}

/**
 * Разбирает артефакт выполнения: исполнитель возвращает плоский результат (не JSON,
 * иначе крупный код ломает экранирование). Снимаем ограждение; summary — первая
 * содержательная строка (для показа/контекста завершения), text — результат целиком.
 */
export function parseExecution(content: string): Omit<ExecutionArtifact, 'files'> {
  const text = stripCodeFence(content);
  const firstMeaningful = text.split('\n').find(line => line.trim().length > 0) ?? '';
  return { summary: firstMeaningful.trim().slice(0, 200), log: [], text };
}

/** Разбирает артефакт проверки (passed/issues; фолбэк ищет признак провала). */
export function parseVerification(content: string): VerificationArtifact {
  const object = parseObject(content);
  if (object !== null) {
    return {
      passed: object.passed === true,
      issues: asStrings(object.issues),
      text: asString(object.text) || content,
    };
  }
  // Пустой ответ — вердикта нет, доверять «pass» нельзя.
  if (content.trim() === '') {
    return { passed: false, issues: ['Проверка не вернула ответа'], text: content };
  }
  // Без структуры: считаем проваленным, если упомянут провал/fail.
  const passed = !/\b(fail|провал|не пройдено|не выполнено)\b/i.test(content);
  return { passed, issues: passed ? [] : extractBullets(content), text: content };
}

/** Разбирает артефакт завершения. */
export function parseCompletion(content: string): CompletionArtifact {
  const object = parseObject(content);
  if (object !== null) {
    return {
      summary: asString(object.summary) || content.split('\n')[0],
      text: asString(object.text) || content,
    };
  }
  return { summary: content.split('\n')[0], text: content };
}

// --- Раннеры этапов (один агент на этап) ---

const PLANNER_SYSTEM =
  'Ты — планировщик. Разбей задачу на конкретные выполнимые шаги (steps) и сформулируй ' +
  'критерии приёмки (criteria) — измеримые и проверяемые. И steps, и criteria ОБЯЗАТЕЛЬНЫ ' +
  'и не должны быть пустыми; не описывай план только прозой в "text" — заполни массив ' +
  '"steps". Ответь ТОЛЬКО объектом JSON (без обрамляющего текста): ' +
  '{"steps":[...], "criteria":[...], "text": "краткий план словами"}.';

const EXECUTOR_SYSTEM =
  'Ты — исполнитель. Выполни задачу строго по плану и критериям и верни ГОТОВЫЙ РЕЗУЛЬТАТ ' +
  'напрямую (для кода — только код, без пояснений). НЕ оборачивай ответ в JSON и НЕ ' +
  'используй markdown-ограждения (```).';

const VERIFIER_SYSTEM =
  'Ты — придирчивый проверяющий. Пройдись по КАЖДОМУ критерию приёмки отдельно и реши, ' +
  'выполнен ли он. Общий "passed" равен true ТОЛЬКО если выполнены все критерии. Если ' +
  'критериев нет или результат пуст — это провал (passed:false). Ответь ТОЛЬКО объектом ' +
  'JSON: {"passed": true|false, "issues": ["что не так, по критериям"], "text": "вывод проверки"}.';

const COMPLETER_SYSTEM =
  'Ты — завершающий. Сформулируй краткий итог выполненной задачи для пользователя. ' +
  'Ответь ТОЛЬКО объектом JSON: {"summary": "итог одной фразой", "text": "итоговое резюме"}.';

/** Низкая температура проверяющего — для стабильного, воспроизводимого вердикта. */
const VERIFIER_TEMPERATURE = 0;

/** Контекстный префикс памяти задачи (или пусто). */
function memoryPrefix(ctx: StageContext): string {
  const context = ctx.memoryContext();
  return context ? `${context}\n\n` : '';
}

/** Планирование: задача (+память +правка) → план с критериями. */
export async function runPlanning(ctx: StageContext): Promise<PlanningArtifact> {
  const conversation = ctx.makeConversation(PLANNER_SYSTEM);
  const correction = ctx.run.correction
    ? `\n\nУчти правку пользователя: ${ctx.run.correction}`
    : '';
  const result = await conversation.ask(
    `${memoryPrefix(ctx)}Задача: ${ctx.run.title}${correction}`,
  );
  return parsePlanning(result.content);
}

/** Выполнение: план (+проблемы проверки/правка) → результат; крупный текст в файл. */
export async function runExecution(ctx: StageContext): Promise<ExecutionArtifact> {
  const plan = ctx.run.artifacts.planning;
  const issues = ctx.run.artifacts.verification?.issues ?? [];
  const conversation = ctx.makeConversation(EXECUTOR_SYSTEM);
  // Шаги, а если их нет — план прозой (модель иногда кладёт план в text).
  const planBody = plan?.steps.length ? plan.steps.join('\n') : (plan?.text ?? '');
  const prompt =
    `${memoryPrefix(ctx)}Задача: ${ctx.run.title}\n\nПлан:\n${planBody}\n\n` +
    `Критерии приёмки:\n${(plan?.criteria ?? []).join('\n')}` +
    (issues.length > 0 ? `\n\nИсправь замечания проверки:\n${issues.join('\n')}` : '') +
    (ctx.run.correction ? `\n\nУчти правку пользователя: ${ctx.run.correction}` : '');
  const result = await conversation.ask(prompt);
  const parsed = parseExecution(result.content);
  // Полный результат сохраняем файлом-артефактом (если хранилище доступно).
  const path = ctx.writeArtifact(`execution-${ctx.run.retries + 1}.md`, parsed.text);
  return { ...parsed, files: path === null ? [] : [path] };
}

/** Проверка: результат против требований/критериев → вердикт + замечания. */
export async function runVerification(ctx: StageContext): Promise<VerificationArtifact> {
  const plan = ctx.run.artifacts.planning;
  const execution = ctx.run.artifacts.execution;
  // Без критериев сверять не с чем — это провал по построению (модель не зовём).
  if (plan === undefined || plan.criteria.length === 0) {
    return {
      passed: false,
      issues: ['Критерии приёмки не сформулированы — нужно переформулировать план.'],
      text: 'Проверка невозможна: пустые критерии приёмки.',
    };
  }
  const conversation = ctx.makeConversation(VERIFIER_SYSTEM, undefined, VERIFIER_TEMPERATURE);
  const result = await conversation.ask(
    `${memoryPrefix(ctx)}Задача: ${ctx.run.title}\n\n` +
      `План:\n${plan.steps.join('\n')}\n\n` +
      `Критерии приёмки:\n${plan.criteria.join('\n')}\n\n` +
      // Берём полный результат; если его нет — краткое резюме (хрупкость поля).
      `Результат на проверку:\n${execution?.text || execution?.summary || ''}`,
  );
  return parseVerification(result.content);
}

/** Завершение: все артефакты → итоговое резюме. */
export async function runCompletion(ctx: StageContext): Promise<CompletionArtifact> {
  const { planning, execution, verification } = ctx.run.artifacts;
  const conversation = ctx.makeConversation(COMPLETER_SYSTEM);
  const prompt =
    `Задача: ${ctx.run.title}\n\nПлан:\n${planning?.text ?? ''}\n\n` +
    `Результат:\n${execution?.summary ?? ''}\n\nПроверка: ${verification?.passed ? 'пройдена' : 'с замечаниями'}`;
  const result = await conversation.ask(prompt);
  return parseCompletion(result.content);
}
