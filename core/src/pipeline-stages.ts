import type { Conversation } from './conversation.ts';
import type { GenerationLimits } from './types.ts';
import type {
  CompletionArtifact,
  ExecutionArtifact,
  PlanningArtifact,
  TaskRun,
  VerificationArtifact,
} from './task-run.ts';
import { parseJsonObject } from './json.ts';
import { orchestrateTeam, runRoleExperts } from './stage-team.ts';
import type { AgentRole, TeamPlan } from './stage-team.ts';

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
  /**
   * Защищённая генерация для РЕШАЮЩИХ этапов (planning/execution/completion): сверяет
   * результат с инвариантами контролёром и при нарушении перегенерирует. Не задана —
   * обычная генерация (инвариантов нет / контроль отключён).
   */
  enforce?: (produce: (feedback?: string) => Promise<string>) => Promise<string>;
  /** Потолок числа агентов на этап (команда ролей). Не задан/≤1 — однопроходный режим. */
  maxStageAgents?: number;
  /** Максимум одновременных запросов роль-агентов внутри этапа (по умолчанию 1). */
  stageAgentConcurrency?: number;
  /** Сообщает драйверу состав команды этапа (для печати решения оркестратора). */
  reportTeam?: (team: TeamPlan) => void;
}

/** Генерация с контролем инвариантов, если он задан; иначе — обычная. */
function guarded(
  ctx: StageContext,
  produce: (feedback?: string) => Promise<string>,
): Promise<string> {
  return ctx.enforce ? ctx.enforce(produce) : produce();
}

// Ленивый разбор JSON-артефактов вынесен в ./json.ts (extractJsonObject/parseJsonObject):
// JSON просим в промпте без response_format, ответ устойчиво вынимается из прозы.

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
  const object = parseJsonObject(content);
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
  const object = parseJsonObject(content);
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
  const object = parseJsonObject(content);
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
  'Ты — планировщик. Составь ДЕТАЛЬНЫЙ план решения. "steps" — конкретные последовательные ' +
  'шаги: для КАЖДОГО шага укажи, что именно сделать и какой результат/артефакт он даёт (где ' +
  'уместно — ответственную роль и ориентир по очерёдности); не ограничивайся общими фразами и ' +
  'НЕ описывай план только прозой в "text". "criteria" — измеримые проверяемые критерии ' +
  'приёмки, СОРАЗМЕРНЫЕ задаче: немного (обычно 3–6) ключевых, реально подтверждающих решение; ' +
  'НЕ раздувай требования и не добавляй необязательных «улучшений» (стиль, крайние ' +
  'Unicode-случаи, микрооптимизации), если задача их прямо не просит. И steps, и criteria ' +
  'ОБЯЗАТЕЛЬНЫ и не должны быть пустыми. Ответь ТОЛЬКО объектом JSON (без обрамляющего текста): ' +
  '{"steps":[...], "criteria":[...], "text": "краткий план словами"}.';

const EXECUTOR_SYSTEM =
  'Ты — исполнитель. Выполни задачу строго по плану и критериям и верни ГОТОВЫЙ РЕЗУЛЬТАТ ' +
  'напрямую (для кода — только код, без пояснений). НЕ оборачивай ответ в JSON и НЕ ' +
  'используй markdown-ограждения (```).';

const VERIFIER_SYSTEM =
  'Ты — проверяющий. Пройдись по КАЖДОМУ критерию приёмки отдельно и реши, выполнен ли он ' +
  'ПО СУЩЕСТВУ. Проверяй ТОЛЬКО заявленные критерии — не придумывай новых требований и не ' +
  'снижай вердикт за улучшения сверх критериев (стиль, дополнительные крайние случаи, ' +
  'оптимизации), если их не требуют критерии. Общий "passed" равен true, если по существу ' +
  'выполнены все критерии (мелкие непринципиальные замечания можно перечислить в issues, ' +
  'но они не делают passed=false). Если критериев нет или результат пуст — это провал ' +
  '(passed:false). Ответь ТОЛЬКО объектом JSON: ' +
  '{"passed": true|false, "issues": ["что не так, по критериям"], "text": "вывод проверки"}.';

const COMPLETER_SYSTEM =
  'Ты — завершающий. Сформулируй краткий итог выполненной задачи для пользователя. ' +
  'Ответь ТОЛЬКО объектом JSON: {"summary": "итог одной фразой", "text": "итоговое резюме"}.';

/** Низкая температура проверяющего — для стабильного, воспроизводимого вердикта. */
const VERIFIER_TEMPERATURE = 0;

/** Персона роль-эксперта планирования: предложения со своего ракурса (без JSON). */
function plannerRoleSystem(role: AgentRole): string {
  return (
    `Ты — ${role.name} в команде планирования.` +
    (role.focus ? ` Твой фокус: ${role.focus}.` : '') +
    ' Со своего ракурса предложи лишь НЕМНОГО (1–3) самых важных шагов и критериев приёмки — ' +
    'только то, что действительно критично для решения. Не раздувай требования, не добавляй ' +
    'необязательных «улучшений» и крайних случаев, которых задача не требует. Будь конкретен ' +
    'и не выходи за рамки своей роли — общий план соберёт ведущий планировщик. Ответь кратко ' +
    'по делу (можно списком); JSON не требуется.'
  );
}

/** Персона синтезатора: свести предложения экспертов в один детальный, но соразмерный план. */
const PLAN_SYNTHESIZER_SYSTEM =
  'Ты — ведущий планировщик. Тебе даны предложения экспертов разных ролей. Сведи их в ОДИН ' +
  'связный ДЕТАЛЬНЫЙ план. "steps" — конкретные последовательные шаги: для каждого укажи, что ' +
  'сделать и какой результат он даёт (а не общее резюме); собери в шагах содержательный вклад ' +
  'всех ролей. "criteria" — ДИСТИЛЛИРУЙ: оставь немного (обычно 3–6) существенных измеримых ' +
  'критериев, отбросив дубли, придирки и необязательные «улучшения»; не требуй того, чего ' +
  'задача не просит. И steps, и criteria ОБЯЗАТЕЛЬНЫ и не должны быть пустыми. Ответь ТОЛЬКО ' +
  'объектом JSON: {"steps":[...], "criteria":[...], "text": "краткий план словами"}.';

/**
 * Направленный добор критериев приёмки: узкий запрос (только критерии по уже готовому
 * плану) модель выполняет надёжнее, чем повторную выдачу всего плана JSON-ом.
 */
const PLAN_CRITERIA_EXTRACT =
  'Сформулируй немного (3–6) ключевых ИЗМЕРИМЫХ критериев приёмки для приведённого ниже плана ' +
  '— по которым можно однозначно проверить результат. Ответь ТОЛЬКО объектом JSON: ' +
  '{"criteria":[...]}.';

/** Контекстный префикс памяти задачи (или пусто). */
function memoryPrefix(ctx: StageContext): string {
  const context = ctx.memoryContext();
  return context ? `${context}\n\n` : '';
}

/** Безопасное имя файла из роли (не-буквы/цифры → дефис). */
function fileSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/(?:^-|-$)/g, '');
}

/** Базовое задание планировщику: задача с памятью и (опц.) правкой пользователя. */
function planningBrief(ctx: StageContext): string {
  const correction = ctx.run.correction
    ? `\n\nУчти правку пользователя: ${ctx.run.correction}`
    : '';
  return `${memoryPrefix(ctx)}Задача: ${ctx.run.title}${correction}`;
}

/**
 * Прогон решающего диалога планирования с гарантией критериев приёмки: критерии —
 * главный гейт проверки, поэтому при их отсутствии (план ушёл прозой) добираем их
 * направленным запросом до 2 раз. Без критериев проверка проходит по расплывчатому
 * тексту даром. Шаги в "text" допустимы — их разворачивает выполнение.
 */
async function planFromConversation(
  ctx: StageContext,
  conversation: Conversation,
  initialPrompt: string,
): Promise<PlanningArtifact> {
  const artifact = parsePlanning(
    await guarded(ctx, feedback =>
      conversation.ask(feedback ?? initialPrompt).then(r => r.content),
    ),
  );
  for (let attempt = 0; artifact.criteria.length === 0 && attempt < 2; attempt++) {
    const planBody = artifact.steps.length > 0 ? artifact.steps.join('\n') : artifact.text;
    const extracted = parsePlanning(
      await guarded(ctx, feedback =>
        conversation
          .ask(feedback ?? `${PLAN_CRITERIA_EXTRACT}\n\nПлан:\n${planBody}`)
          .then(r => r.content),
      ),
    );
    if (extracted.criteria.length > 0) {
      artifact.criteria = extracted.criteria;
    }
  }
  return artifact;
}

/** Одиночное планирование: один планировщик (исходный режим). */
function planSolo(ctx: StageContext): Promise<PlanningArtifact> {
  return planFromConversation(ctx, ctx.makeConversation(PLANNER_SYSTEM), planningBrief(ctx));
}

/**
 * Командное планирование: роль-эксперты дают предложения (ограниченно-параллельно),
 * синтезатор сводит их в единый план. Все эксперты упали → откат к одиночному режиму.
 */
async function planWithTeam(ctx: StageContext, team: TeamPlan): Promise<PlanningArtifact> {
  const brief = planningBrief(ctx);
  const contributions = await runRoleExperts({
    roles: team.roles,
    makeConversation: ctx.makeConversation,
    buildSystem: plannerRoleSystem,
    buildPrompt: () => brief,
    concurrency: ctx.stageAgentConcurrency ?? 1,
  });
  if (contributions.length === 0) {
    return planSolo(ctx);
  }
  // Вклады экспертов — файлами-артефактами (наблюдаемость) и в задание синтезатора.
  contributions.forEach((contribution, index) =>
    ctx.writeArtifact(
      `planning-team-${index + 1}-${fileSlug(contribution.role)}.md`,
      contribution.text,
    ),
  );
  const briefing = contributions
    .map(contribution => `### ${contribution.role}\n${contribution.text}`)
    .join('\n\n');
  const synthesizer = ctx.makeConversation(PLAN_SYNTHESIZER_SYSTEM);
  const artifact = await planFromConversation(
    ctx,
    synthesizer,
    `${brief}\n\nПредложения экспертов:\n${briefing}`,
  );
  return { ...artifact, contributions };
}

/**
 * Планирование: оркестратор решает состав команды. Один агент → одиночный режим;
 * команда ролей → эксперты + синтез в единый план. Память+правка идут в обе ветки.
 */
export async function runPlanning(ctx: StageContext): Promise<PlanningArtifact> {
  const team = await orchestrateTeam({
    makeConversation: ctx.makeConversation,
    task: ctx.run.title,
    context: ctx.memoryContext(),
    stageLabel: 'планирование',
    maxAgents: ctx.maxStageAgents ?? 1,
  });
  ctx.reportTeam?.(team);
  return team.roles.length <= 1 ? planSolo(ctx) : planWithTeam(ctx, team);
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
  const text = await guarded(ctx, feedback =>
    conversation.ask(feedback ?? prompt).then(result => result.content),
  );
  const parsed = parseExecution(text);
  // Полный результат сохраняем файлом-артефактом (если хранилище доступно).
  const path = ctx.writeArtifact(`execution-${ctx.run.retries + 1}.md`, parsed.text);
  return { ...parsed, files: path === null ? [] : [path] };
}

/** Проверка: результат против критериев → вердикт + замечания. */
export async function runVerification(ctx: StageContext): Promise<VerificationArtifact> {
  const plan = ctx.run.artifacts.planning;
  const execution = ctx.run.artifacts.execution;
  // Основа приёмки: критерии, иначе шаги, иначе текст плана — чтобы не зациклиться
  // на «пустых критериях» (модель иногда отдаёт план прозой).
  let basis = '';
  if (plan !== undefined) {
    if (plan.criteria.length > 0) {
      basis = `План:\n${plan.steps.join('\n')}\n\nКритерии приёмки (сверяй результат по ним):\n${plan.criteria.join('\n')}`;
    } else if (plan.steps.length > 0) {
      basis = `Шаги плана (критериев нет — сверяй результат по ним):\n${plan.steps.join('\n')}`;
    } else if (plan.text) {
      basis = `План (критериев и шагов нет — сверяй результат по нему):\n${plan.text}`;
    }
  }
  // Совсем пустой план — сверять не с чем (модель не зовём).
  if (basis === '') {
    return {
      passed: false,
      issues: ['План пуст — нечего проверять; нужно переформулировать план.'],
      text: 'Проверка невозможна: пустой план.',
    };
  }
  const conversation = ctx.makeConversation(VERIFIER_SYSTEM, undefined, VERIFIER_TEMPERATURE);
  const result = await conversation.ask(
    `${memoryPrefix(ctx)}Задача: ${ctx.run.title}\n\n${basis}\n\n` +
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
  const text = await guarded(ctx, feedback =>
    conversation.ask(feedback ?? prompt).then(result => result.content),
  );
  return parseCompletion(text);
}
