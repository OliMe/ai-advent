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
import {
  COMPLETION_SCHEMA,
  PLANNING_SCHEMA,
  VERIFICATION_SCHEMA,
  structuredLimits,
} from './pipeline-schemas.ts';
import { orchestrateTeam, runRoleExperts } from './stage-team.ts';
import type { AgentRole, TeamPlan } from './stage-team.ts';
import type { ToolSet } from './tool-set.ts';
import type { CommandCheck, FileWorkspace } from './run-workspace.ts';
import type { CommandResult } from './command-runner.ts';

/** Контекст этапа: всё, что нужно раннеру для одного прогона этапа. */
export interface StageContext {
  run: TaskRun;
  /** Фабрика диалога для агента этапа (промпт, ограничения, температура, опц. инструменты, опц. модель). */
  makeConversation: (
    systemPrompt: string,
    limits?: GenerationLimits,
    temperature?: number,
    tools?: ToolSet,
    model?: string,
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
  /** Инструменты (function-calling) для решающих агентов планирования и выполнения. */
  tools?: ToolSet;
  /**
   * Структурированный вывод этапов по JSON-схеме (constrained decoding). Не задан/false —
   * прежний путь: JSON просим в промпте, разбираем толерантным парсером. Включается явным
   * тумблером пользователя, так как `response_format` ломает z.ai/GLM.
   */
  structuredOutputs?: boolean;
  /**
   * Модель для роли ВЫПОЛНЕНИЯ (напр. специализированная code-модель). Не задана — этап идёт
   * на дефолтную модель клиента, как остальные роли. Смена модели за роль стоит переключения
   * в Ollama, если модели не помещаются в память резидентно.
   */
  executorModel?: string;
  /**
   * Карточки привязанных проектов (День 31): корень, ветка, документация, команды тестов/сборки.
   * Идут в контекст ВСЕХ агентов этапов — дёшево и меняет качество: план и результат должны быть
   * про КОНКРЕТНЫЙ репозиторий, а не «в воздухе». Не задан — прежнее поведение.
   */
  projectContext?: () => string;
  /**
   * Поиск по документации проектов (RAG). Подключается АДРЕСНО — только там, где меняет результат
   * (планирование, проверка): каждый вызов стоит запросов, а на выполнении/завершении добор данных
   * ничего не решает. Не задан — этапы работают как прежде.
   */
  retrieveProjectDocs?: (query: string) => Promise<string[]>;
  /**
   * Файловое пространство выполнения (День 34): инструменты работы с файлами проекта для агента-
   * исполнителя + снимок изменений (diff). Задан — execution РЕАЛЬНО правит файлы (в изолированной
   * копии), артефакт несёт diff. Не задан — execution генерирует текст, как прежде.
   */
  fileWorkspace?: FileWorkspace;
  /**
   * Запуск обнаруженных команд проекта (День 34) для этапа проверки: verification прогоняет
   * test/build/lint на изменениях. Задан — проверка опирается на реальный код выхода. Не задан —
   * проверка судит LLM-ом по тексту, как прежде.
   */
  commandCheck?: CommandCheck;
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

/** Текстовые поля, из которых берём строку, если пункт плана пришёл объектом. */
const STEP_TEXT_KEYS = ['step', 'text', 'name', 'title', 'description', 'criterion', 'action'];

/**
 * Приводит элемент массива плана к строке. Слабая модель (напр. llama3.2:3b) кладёт в
 * "steps"/"criteria" ОБЪЕКТЫ ({name, description, …}) вместо строк — детерминированно
 * достаём из них текстовое поле, чтобы пункт не терялся молча. Не строка и не объект с
 * текстом → null (отбрасывается).
 */
function coercePlanItem(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of STEP_TEXT_KEYS) {
      if (typeof record[key] === 'string' && record[key] !== '') {
        return record[key] as string;
      }
    }
  }
  return null;
}

/** Массив строк из значения: строки как есть, объекты-пункты → их текстовое поле. */
function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(coercePlanItem).filter((item): item is string => item !== null)
    : [];
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

/** Поля-обёртки, в которые слабая модель кладёт САМ результат вместо плоского текста. */
const EXECUTION_RESULT_KEYS = ['implementation', 'code', 'result', 'output', 'answer', 'text'];

/** Поля-описания рядом с результатом: их наличие не мешает распознать обёртку. */
const EXECUTION_META_KEYS = [
  'name',
  'title',
  'language',
  'summary',
  'description',
  'explanation',
  'notes',
  'comments',
  'jsdoccomments',
  'usage',
  'example',
  'examples',
  'tests',
];

/**
 * Детерминированный ремонт: слабая модель иногда игнорирует «верни плоский текст» и отдаёт
 * `{name, implementation, jsdocComments}`. Достаём поле-результат — БЕЗ вызова модели.
 *
 * Правило намеренно узкое: разворачиваем, только если КАЖДЫЙ ключ объекта — известная обёртка
 * или поле-описание. Иначе задача, чей результат сам по себе JSON (например «сгенерируй конфиг»),
 * была бы искалечена вытаскиванием одного её поля. Не распознали — возвращаем null (текст как есть).
 */
function unwrapExecutionObject(content: string): string | null {
  const object = parseJsonObject(content);
  if (object === null) {
    return null;
  }
  const byLowerCaseKey = new Map(
    Object.entries(object).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const known = [...byLowerCaseKey.keys()].every(
    key => EXECUTION_RESULT_KEYS.includes(key) || EXECUTION_META_KEYS.includes(key),
  );
  if (!known) {
    return null;
  }
  for (const key of EXECUTION_RESULT_KEYS) {
    const value = byLowerCaseKey.get(key);
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return null;
}

/**
 * Разбирает артефакт выполнения: исполнитель возвращает плоский результат (не JSON,
 * иначе крупный код ломает экранирование). Сначала детерминированный ремонт обёртки,
 * затем снимаем ограждение; summary — первая содержательная строка (для показа/контекста
 * завершения), text — результат целиком.
 */
export function parseExecution(content: string): Omit<ExecutionArtifact, 'files'> {
  const text = stripCodeFence(unwrapExecutionObject(content) ?? content);
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
  'приёмки, СОРАЗМЕРНЫЕ задаче. Критерии ОБЯЗАНЫ покрывать ВСЕ явно заявленные требования ' +
  'пользователя — особенно к формату и составу результата (требуемые поля/атрибуты каждого ' +
  'элемента, оценки, структуру): если пользователь просит, например, оценку времени в часах или ' +
  'профиль исполнителя для каждой задачи — это ОТДЕЛЬНЫЙ критерий, его нельзя опускать. Критерии ' +
  'должны проверяться ПО САМОМУ результату, который произведёт исполнитель (текст/код); НЕ требуй ' +
  'внешних доказательств — реальных скриншотов, логов, подписанных сканов, видео, работающих ' +
  'систем. «Не раздувать» относится только к НЕзаявленным «улучшениям» (стиль, крайние ' +
  'Unicode-случаи, микрооптимизации) — явные требования пользователя отбрасывать нельзя. И steps, и criteria ' +
  'ОБЯЗАТЕЛЬНЫ и не должны быть пустыми. Ответь ТОЛЬКО объектом JSON (без обрамляющего текста): ' +
  '{"steps":[...], "criteria":[...], "text": "краткий план словами"}. steps и criteria — массивы ' +
  'КОРОТКИХ СТРОК, НЕ объектов. Пример: {"steps":["Создать файл sort.ts с функцией bubbleSort",' +
  '"Пройти массив вложенными циклами, меняя соседние элементы местами"],"criteria":["Функция ' +
  'возвращает новый массив, отсортированный по возрастанию","Пустой массив и массив из одного ' +
  'элемента обрабатываются без ошибок"],"text":"Сортировка пузырьком с копией входного массива"}.';

const EXECUTOR_SYSTEM =
  'Ты — исполнитель. Выполни задачу строго по плану и критериям и верни ГОТОВЫЙ РЕЗУЛЬТАТ ' +
  'напрямую и ЦЕЛИКОМ (для кода — только код, без пояснений). Даже при доработке по замечаниям ' +
  'возвращай ПОЛНЫЙ самостоятельный результат целиком — НЕ отвечай дельтой, списком правок или ' +
  '«отчётом об устранении замечаний». НЕ оборачивай ответ в JSON и НЕ используй ' +
  'markdown-ограждения (```).';

/**
 * Персона исполнителя, работающего с ФАЙЛАМИ проекта (День 34). В отличие от текстового исполнителя,
 * он не возвращает результат текстом, а ВНОСИТ реальные правки инструментами (создание/изменение
 * файлов). Сам решает, что прочитать/найти и что изменить — цель задана на уровне плана.
 */
const EXECUTOR_FILE_SYSTEM =
  'Ты — исполнитель, работающий с ФАЙЛАМИ проекта. У тебя есть инструменты: прочитать файл, найти ' +
  'по коду, посмотреть содержимое каталога, а также СОЗДАТЬ и ИЗМЕНИТЬ файл. Выполни задачу по ' +
  'плану и критериям, ВНОСЯ РЕАЛЬНЫЕ правки инструментами: сам реши, какие файлы прочитать и что ' +
  'изменить, и примени изменения (например, вызвав write_file), а НЕ описывай их словами и не ' +
  'возвращай код в ответе. Пути указывай ОТНОСИТЕЛЬНО корня проекта. Сначала при необходимости ' +
  'изучи нужные файлы, затем внеси правки. Когда всё сделано — верни КРАТКОЕ резюме: какие файлы ' +
  'создал/изменил и что именно. Резюме — обычным текстом, без JSON и без markdown-ограждений.';

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

/**
 * Температуры этапов пайплайна (структурированный вывод — низкая, творчество вредит формату и
 * стабильности; провайдеро-безопасно, с response_format не связано). Планирование/синтез — чуть
 * выше (немного широты для полноты плана), выполнение/завершение — ниже (код/резюме). Роли команды
 * берут свою температуру от оркестратора (там разнообразие уместно) — их эти константы не трогают.
 */
const PLANNER_TEMPERATURE = 0.3;
const EXECUTOR_TEMPERATURE = 0.2;
const COMPLETER_TEMPERATURE = 0.2;

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
  'всех ролей. "criteria" — соразмерные: отбрось дубли, придирки и НЕзаявленные «улучшения», ' +
  'но ОБЯЗАТЕЛЬНО покрой ВСЕ явно заявленные требования пользователя, особенно к формату и ' +
  'составу результата (требуемые поля/атрибуты каждого элемента, оценки, структуру) — например, ' +
  'оценку времени в часах или профиль исполнителя для каждой задачи нельзя опускать. Критерии ' +
  'должны проверяться ПО САМОМУ результату (тексту/коду); не требуй внешних доказательств — ' +
  'реальных скриншотов, логов, подписанных сканов, видео, работающих систем. И steps, и criteria ' +
  'ОБЯЗАТЕЛЬНЫ и не должны быть пустыми. steps и criteria — массивы КОРОТКИХ СТРОК, НЕ объектов. ' +
  'Ответь ТОЛЬКО объектом JSON: {"steps":["конкретный шаг словами", ...], ' +
  '"criteria":["измеримый критерий", ...], "text": "краткий план словами"}.';

/**
 * Направленный добор критериев приёмки: узкий запрос (только критерии по уже готовому
 * плану) модель выполняет надёжнее, чем повторную выдачу всего плана JSON-ом.
 */
const PLAN_CRITERIA_EXTRACT =
  'Сформулируй ключевые ИЗМЕРИМЫЕ критерии приёмки для приведённого ниже плана — по которым ' +
  'можно однозначно проверить результат ПО САМОМУ его содержимому (тексту/коду). ОБЯЗАТЕЛЬНО ' +
  'включи критерии на ВСЕ явно заявленные требования к формату/составу результата (например, ' +
  'наличие оценки времени в часах и профиля исполнителя для КАЖДОЙ задачи, если это требуется). ' +
  'Не требуй внешних доказательств (скриншотов, логов, сканов, видео, работающих систем). ' +
  'Ответь ТОЛЬКО объектом JSON: {"criteria":[...]}.';

/** Контекстный префикс памяти задачи (или пусто). */
function memoryPrefix(ctx: StageContext): string {
  const context = ctx.memoryContext();
  return context ? `${context}\n\n` : '';
}

/** Карточки проектов для агента этапа (или пусто, если проект не привязан). */
function projectPrefix(ctx: StageContext): string {
  const context = ctx.projectContext?.() ?? '';
  return context ? `${context}\n\n` : '';
}

/**
 * Фрагменты документации проекта по запросу — для этапов, где они меняют результат. Пусто, если
 * поиск не подключён (проекта нет / нет rag-сервера) или ничего не нашлось: выдумывать нельзя.
 */
async function projectDocs(ctx: StageContext, query: string): Promise<string> {
  if (ctx.retrieveProjectDocs === undefined) {
    return '';
  }
  const fragments = await ctx.retrieveProjectDocs(query);
  return fragments.length === 0
    ? ''
    : `\n\nДокументация проекта по теме задачи (опирайся на неё, это правда о проекте):\n${fragments.join('\n\n')}`;
}

/** Безопасное имя файла из роли (не-буквы/цифры → дефис). */
function fileSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/(?:^-|-$)/g, '');
}

/**
 * Явные требования прогона (собранные на этапе requirements) — авторитетная спецификация
 * результата. Подаём ЦЕЛИКОМ (не через урезаемую бюджетом память задачи), чтобы планирование
 * и выполнение не теряли заявленные требования к формату/составу результата.
 */
function requirementsBlock(ctx: StageContext): string {
  const collected = ctx.run.artifacts.requirements?.collected ?? [];
  return collected.length > 0
    ? '\n\nТребования пользователя (учти КАЖДОЕ, особенно к формату и составу результата):\n' +
        collected.map(item => `- ${item}`).join('\n')
    : '';
}

/** Базовое задание планировщику: задача с памятью, требованиями и (опц.) правкой пользователя. */
function planningBrief(ctx: StageContext, docs: string): string {
  const correction = ctx.run.correction
    ? `\n\nУчти правку пользователя: ${ctx.run.correction}`
    : '';
  return (
    `${projectPrefix(ctx)}${memoryPrefix(ctx)}Задача: ${ctx.run.title}` +
    `${requirementsBlock(ctx)}${docs}${correction}`
  );
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
function planSolo(ctx: StageContext, docs: string): Promise<PlanningArtifact> {
  return planFromConversation(
    ctx,
    ctx.makeConversation(
      PLANNER_SYSTEM,
      structuredLimits(ctx.structuredOutputs, PLANNING_SCHEMA),
      PLANNER_TEMPERATURE,
      ctx.tools,
    ),
    planningBrief(ctx, docs),
  );
}

/**
 * Командное планирование: роль-эксперты дают предложения (ограниченно-параллельно),
 * синтезатор сводит их в единый план. Все эксперты упали → откат к одиночному режиму.
 */
async function planWithTeam(
  ctx: StageContext,
  team: TeamPlan,
  docs: string,
): Promise<PlanningArtifact> {
  const brief = planningBrief(ctx, docs);
  const contributions = await runRoleExperts({
    roles: team.roles,
    makeConversation: ctx.makeConversation,
    buildSystem: plannerRoleSystem,
    buildPrompt: () => brief,
    concurrency: ctx.stageAgentConcurrency ?? 1,
  });
  if (contributions.length === 0) {
    return planSolo(ctx, docs);
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
  const synthesizer = ctx.makeConversation(
    PLAN_SYNTHESIZER_SYSTEM,
    structuredLimits(ctx.structuredOutputs, PLANNING_SCHEMA),
    PLANNER_TEMPERATURE,
    ctx.tools,
  );
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
  // Документация проекта — на планировании она решает: план должен быть в терминах реальной
  // структуры и соглашений репозитория, а не абстрактным. Добывается один раз на этап.
  const docs = await projectDocs(ctx, ctx.run.title);
  const team = await orchestrateTeam({
    makeConversation: ctx.makeConversation,
    task: ctx.run.title,
    context: ctx.memoryContext(),
    stageLabel: 'планирование',
    maxAgents: ctx.maxStageAgents ?? 1,
  });
  ctx.reportTeam?.(team);
  return team.roles.length <= 1 ? planSolo(ctx, docs) : planWithTeam(ctx, team, docs);
}

/** План этапа выполнения телом (шаги, иначе проза из text) + критерии приёмки строкой. */
function executionPlanBody(ctx: StageContext): { planBody: string; criteria: string } {
  const plan = ctx.run.artifacts.planning;
  // Шаги, а если их нет — план прозой (модель иногда кладёт план в text).
  const planBody = plan?.steps.length ? plan.steps.join('\n') : (plan?.text ?? '');
  return { planBody, criteria: (plan?.criteria ?? []).join('\n') };
}

/**
 * Выполнение: план (+проблемы проверки/правка) → результат. С файловым пространством (`fileWorkspace`)
 * агент РЕАЛЬНО правит файлы проекта в изолированной копии, а артефакт несёт diff; иначе — как прежде,
 * результат генерируется текстом и сохраняется файлом-артефактом прогона.
 */
export async function runExecution(ctx: StageContext): Promise<ExecutionArtifact> {
  return ctx.fileWorkspace === undefined
    ? runTextExecution(ctx)
    : runFileExecution(ctx, ctx.fileWorkspace);
}

/** Текстовое выполнение: результат — плоский текст, сохраняется файлом-артефактом прогона. */
async function runTextExecution(ctx: StageContext): Promise<ExecutionArtifact> {
  const issues = ctx.run.artifacts.verification?.issues ?? [];
  // Предыдущий результат — чтобы доработать его целиком, а не пересоздавать с нуля.
  const previous = ctx.run.artifacts.execution?.text ?? '';
  const conversation = ctx.makeConversation(
    EXECUTOR_SYSTEM,
    undefined,
    EXECUTOR_TEMPERATURE,
    ctx.tools,
    ctx.executorModel,
  );
  const { planBody, criteria } = executionPlanBody(ctx);
  // Доработка (после провала проверки или отказа): требуем ПОЛНЫЙ результат, а не дельту,
  // иначе исполнитель отдаёт «отчёт об устранении замечаний» вместо целого результата.
  const revision =
    issues.length > 0 || ctx.run.correction
      ? '\n\nЭто ДОРАБОТКА. Верни ПОЛНЫЙ итоговый результат ЦЕЛИКОМ — по всему плану и всем ' +
        'критериям, а не отчёт об изменениях и не список правок. Устрани замечания, сохранив ' +
        'всё уже корректное.' +
        (previous ? `\n\nТвой предыдущий результат (доработай его целиком):\n${previous}` : '') +
        (issues.length > 0 ? `\n\nЗамечания проверки (устрани все):\n${issues.join('\n')}` : '') +
        (ctx.run.correction ? `\n\nПравка пользователя: ${ctx.run.correction}` : '')
      : '';
  const prompt =
    `${projectPrefix(ctx)}${memoryPrefix(ctx)}Задача: ${ctx.run.title}${requirementsBlock(ctx)}` +
    `\n\nПлан:\n${planBody}\n\nКритерии приёмки:\n${criteria}${revision}`;
  const text = await guarded(ctx, feedback =>
    conversation.ask(feedback ?? prompt).then(result => result.content),
  );
  const parsed = parseExecution(text);
  // Полный результат сохраняем файлом-артефактом (если хранилище доступно).
  const path = ctx.writeArtifact(`execution-${ctx.run.retries + 1}.md`, parsed.text);
  return { ...parsed, files: path === null ? [] : [path] };
}

/**
 * Файловое выполнение: агент правит файлы проекта инструментами `fileWorkspace.tools` (function-
 * calling), а результат снимается как diff. `files` — реально изменённые файлы проекта (create/
 * modify/delete), `text` — резюме агента + фактический diff (его видят проверка и пользователь).
 */
async function runFileExecution(
  ctx: StageContext,
  workspace: FileWorkspace,
): Promise<ExecutionArtifact> {
  const issues = ctx.run.artifacts.verification?.issues ?? [];
  const conversation = ctx.makeConversation(
    EXECUTOR_FILE_SYSTEM,
    undefined,
    EXECUTOR_TEMPERATURE,
    workspace.tools,
    ctx.executorModel,
  );
  const { planBody, criteria } = executionPlanBody(ctx);
  // Доработка: файлы уже содержат прошлые правки агента (одна и та же копия), поэтому просим не
  // переделывать с нуля, а устранить замечания правкой файлов.
  const revision =
    issues.length > 0 || ctx.run.correction
      ? '\n\nЭто ДОРАБОТКА: файлы уже содержат твой прошлый результат — устрани замечания, правя ' +
        'файлы инструментами (не переделывай с нуля).' +
        (issues.length > 0 ? `\n\nЗамечания проверки (устрани все):\n${issues.join('\n')}` : '') +
        (ctx.run.correction ? `\n\nПравка пользователя: ${ctx.run.correction}` : '')
      : '';
  const prompt =
    `${projectPrefix(ctx)}${memoryPrefix(ctx)}Задача: ${ctx.run.title}${requirementsBlock(ctx)}` +
    `\n\nПлан:\n${planBody}\n\nКритерии приёмки:\n${criteria}${revision}`;
  const summaryText = await guarded(ctx, feedback =>
    conversation.ask(feedback ?? prompt).then(result => result.content),
  );
  const { diff, files } = await workspace.changeSummary();
  const cleaned = stripCodeFence(summaryText).trim();
  const text =
    diff.trim() === ''
      ? `${cleaned}\n\nИзменений в файлах нет.`
      : `${cleaned}\n\nИзменения в файлах:\n${diff}`;
  // Резюме — по фактически изменённым файлам (что и волнует пользователя); нет правок — первая
  // содержательная строка ответа агента.
  const summary =
    files.length > 0
      ? `Изменено файлов: ${files.length} (${files.join(', ')})`
      : (cleaned.split('\n').find(line => line.trim().length > 0) ?? '').trim().slice(0, 200);
  return { summary, files, log: [], text };
}

/** Команды проекта, прогоняемые на проверке (start исключён — он не завершается). */
const VERIFIED_COMMAND_KINDS = ['test', 'build', 'lint'] as const;

/** Максимум символов вывода команды в замечании (хвост важнее — там ошибка). */
const COMMAND_OUTPUT_TAIL_LIMIT = 1500;

/** Хвост вывода команды для замечаний (последние символы stdout+stderr). */
function commandOutputTail(result: CommandResult): string {
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  return combined.length > COMMAND_OUTPUT_TAIL_LIMIT
    ? `…${combined.slice(-COMMAND_OUTPUT_TAIL_LIMIT)}`
    : combined;
}

/**
 * Прогон обнаруженных команд проекта (test/build/lint) на изменениях. Возвращает результаты и
 * подмножество провалившихся (ненулевой код или таймаут). Команда не обнаружена — пропускается.
 */
async function runProjectCommands(
  check: CommandCheck,
): Promise<{ results: CommandResult[]; failed: CommandResult[] }> {
  const results: CommandResult[] = [];
  for (const kind of VERIFIED_COMMAND_KINDS) {
    const command = check.commands[kind];
    if (command !== undefined) {
      results.push(await check.run(command));
    }
  }
  return { results, failed: results.filter(result => result.timedOut || result.code !== 0) };
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
  // Реальная проверка ЗАПУСКОМ (День 34): прогоняем обнаруженные команды проекта на изменениях.
  // Любой ненулевой код — объективный провал: возвращаемся в execution (агент правит), модель не
  // зовём. Все пройдены — их результаты идут в контекст судьи (тесты зелёные — весомый довод).
  let commandBlock = '';
  if (ctx.commandCheck !== undefined) {
    const { results, failed } = await runProjectCommands(ctx.commandCheck);
    if (failed.length > 0) {
      return {
        passed: false,
        issues: failed.map(
          result =>
            `Команда \`${result.command}\` ${result.timedOut ? 'прервана по таймауту' : `завершилась с кодом ${result.code}`}:\n${commandOutputTail(result)}`,
        ),
        text: `Проверка запуском не пройдена (${failed.length} из ${results.length} команд).`,
      };
    }
    if (results.length > 0) {
      commandBlock =
        '\n\nРезультаты команд проекта (все пройдены, код 0):\n' +
        results.map(result => `- \`${result.command}\` → код ${result.code}`).join('\n');
    }
  }
  const conversation = ctx.makeConversation(
    VERIFIER_SYSTEM,
    structuredLimits(ctx.structuredOutputs, VERIFICATION_SCHEMA),
    VERIFIER_TEMPERATURE,
  );
  // Документация проекта и на проверке решает: результат сверяется с соглашениями проекта,
  // а не только с критериями плана.
  const docs = await projectDocs(ctx, ctx.run.title);
  const result = await conversation.ask(
    `${projectPrefix(ctx)}${memoryPrefix(ctx)}Задача: ${ctx.run.title}${docs}\n\n${basis}${commandBlock}\n\n` +
      // Берём полный результат; если его нет — краткое резюме (хрупкость поля).
      `Результат на проверку:\n${execution?.text || execution?.summary || ''}`,
  );
  return parseVerification(result.content);
}

/** Завершение: все артефакты → итоговое резюме. */
export async function runCompletion(ctx: StageContext): Promise<CompletionArtifact> {
  const { planning, execution, verification } = ctx.run.artifacts;
  const conversation = ctx.makeConversation(
    COMPLETER_SYSTEM,
    structuredLimits(ctx.structuredOutputs, COMPLETION_SCHEMA),
    COMPLETER_TEMPERATURE,
  );
  const prompt =
    `${projectPrefix(ctx)}Задача: ${ctx.run.title}\n\nПлан:\n${planning?.text ?? ''}\n\n` +
    `Результат:\n${execution?.summary ?? ''}\n\nПроверка: ${verification?.passed ? 'пройдена' : 'с замечаниями'}`;
  const text = await guarded(ctx, feedback =>
    conversation.ask(feedback ?? prompt).then(result => result.content),
  );
  return parseCompletion(text);
}
