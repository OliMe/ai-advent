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
  /** Фабрика диалога для агента этапа (свой системный промпт и ограничения). */
  makeConversation: (systemPrompt: string, limits?: GenerationLimits) => Conversation;
  /** Пишет файл-артефакт прогона; null — хранилище отключено (--ephemeral). */
  writeArtifact: (name: string, content: string) => string | null;
}

const JSON_LIMITS: GenerationLimits = { responseFormat: { type: 'json_object' } };

// --- Ленивый разбор (формат C: json_object; фолбэк D: текст/буллеты) ---

/** Парсит JSON-объект из ответа модели или null. */
function parseObject(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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

/** Разбирает артефакт выполнения (без files — их проставляет раннер). */
export function parseExecution(content: string): Omit<ExecutionArtifact, 'files'> {
  const object = parseObject(content);
  if (object !== null) {
    return {
      summary: asString(object.summary),
      log: asStrings(object.log),
      text: asString(object.text) || content,
    };
  }
  return { summary: content.split('\n')[0], log: [], text: content };
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
  'Ты — планировщик. Разбей задачу на конкретные выполнимые шаги и сформулируй ' +
  'критерии приёмки, по которым потом проверят результат. Верни СТРОГО JSON: ' +
  '{"steps":[...], "criteria":[...], "text": "краткий план словами"}.';

const EXECUTOR_SYSTEM =
  'Ты — исполнитель. Выполни задачу строго по плану и критериям. Верни СТРОГО JSON: ' +
  '{"summary": "что сделано", "log": ["шаги"], "text": "полный результат работы"}.';

const VERIFIER_SYSTEM =
  'Ты — придирчивый проверяющий. Сверь результат с КАЖДЫМ критерием приёмки. Верни ' +
  'СТРОГО JSON: {"passed": true|false, "issues": ["что не так"], "text": "вывод проверки"}.';

const COMPLETER_SYSTEM =
  'Ты — завершающий. Сформулируй краткий итог выполненной задачи для пользователя. ' +
  'Верни СТРОГО JSON: {"summary": "итог одной фразой", "text": "итоговое резюме"}.';

/** Планирование: задача (+правка) → план с критериями. */
export async function runPlanning(ctx: StageContext): Promise<PlanningArtifact> {
  const conversation = ctx.makeConversation(PLANNER_SYSTEM, JSON_LIMITS);
  const correction = ctx.run.correction
    ? `\n\nУчти правку пользователя: ${ctx.run.correction}`
    : '';
  const result = await conversation.ask(`Задача: ${ctx.run.title}${correction}`);
  return parsePlanning(result.content);
}

/** Выполнение: план (+проблемы проверки/правка) → результат; крупный текст в файл. */
export async function runExecution(ctx: StageContext): Promise<ExecutionArtifact> {
  const plan = ctx.run.artifacts.planning;
  const issues = ctx.run.artifacts.verification?.issues ?? [];
  const conversation = ctx.makeConversation(EXECUTOR_SYSTEM, JSON_LIMITS);
  const prompt =
    `Задача: ${ctx.run.title}\n\nПлан:\n${(plan?.steps ?? []).join('\n')}\n\n` +
    `Критерии приёмки:\n${(plan?.criteria ?? []).join('\n')}` +
    (issues.length > 0 ? `\n\nИсправь замечания проверки:\n${issues.join('\n')}` : '') +
    (ctx.run.correction ? `\n\nУчти правку пользователя: ${ctx.run.correction}` : '');
  const result = await conversation.ask(prompt);
  const parsed = parseExecution(result.content);
  // Полный результат сохраняем файлом-артефактом (если хранилище доступно).
  const path = ctx.writeArtifact(`execution-${ctx.run.retries + 1}.md`, parsed.text);
  return { ...parsed, files: path === null ? [] : [path] };
}

/** Проверка: результат против критериев → вердикт + замечания. */
export async function runVerification(ctx: StageContext): Promise<VerificationArtifact> {
  const plan = ctx.run.artifacts.planning;
  const execution = ctx.run.artifacts.execution;
  const conversation = ctx.makeConversation(VERIFIER_SYSTEM, JSON_LIMITS);
  const prompt =
    `Критерии приёмки:\n${(plan?.criteria ?? []).join('\n')}\n\n` +
    `Результат на проверку:\n${execution?.text ?? ''}`;
  const result = await conversation.ask(prompt);
  return parseVerification(result.content);
}

/** Завершение: все артефакты → итоговое резюме. */
export async function runCompletion(ctx: StageContext): Promise<CompletionArtifact> {
  const { planning, execution, verification } = ctx.run.artifacts;
  const conversation = ctx.makeConversation(COMPLETER_SYSTEM, JSON_LIMITS);
  const prompt =
    `Задача: ${ctx.run.title}\n\nПлан:\n${planning?.text ?? ''}\n\n` +
    `Результат:\n${execution?.summary ?? ''}\n\nПроверка: ${verification?.passed ? 'пройдена' : 'с замечаниями'}`;
  const result = await conversation.ask(prompt);
  return parseCompletion(result.content);
}
