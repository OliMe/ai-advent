import { readFileSync } from 'node:fs';
import type { GenerationLimits, ResponseFormat, MemoryKind } from '../../core/src/index.ts';

/** Сколько последних реплик стратегия summary держит дословно по умолчанию. */
export const DEFAULT_KEEP_RECENT = 6;

/**
 * Проверяет температуру: конечное неотрицательное число; возвращает число или
 * null при ошибке. Верхнюю границу не навязываем — она зависит от провайдера
 * (z.ai/GLM ≈ 0–1, OpenAI ≈ 0–2), и провайдер сам отклонит слишком большое.
 */
export function validTemperature(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Результат разбора аргументов: промпт, ограничения, флаги и температура. */
export interface ParsedArgs {
  prompt: string;
  limits: GenerationLimits;
  disableThinking: boolean;
  /** Температура из флага `--temperature`; undefined — взять из конфигурации. */
  temperature?: number;
  /** Размер контекста из флага `--context-tokens`; undefined — взять из конфигурации. */
  contextTokens?: number;
  /** Потоковый вывод ответа; выключается флагом `--no-stream`. */
  stream: boolean;
  /** Не сохранять сессию (флаг `--ephemeral`). */
  ephemeral: boolean;
  /** Переключиться на ветку при старте: `last`, имя или id (`--switch`). */
  switchTo?: string;
  /** Ответвиться в новую ветку с этим именем при старте (`--branch`). */
  branchName?: string;
  /** Файлы (`--file`, можно несколько), чьё содержимое идёт в запрос. */
  files: string[];
  /** Стратегия управления памятью диалога (`--memory`); по умолчанию `window`. */
  memory: MemoryKind;
  /** Сколько последних реплик держать дословно при summary (`--keep-recent`). */
  keepRecent: number;
  /** Выключить слоистую память — профиль и задачу (`--no-memory`). */
  noMemory: boolean;
  /** Стартовая задача (`--task <текст>`). */
  task?: string;
  /** Активный профиль (персона) при старте (`--profile <имя>`). */
  profile?: string;
  /** Размер блока профиля в токенах (`--profile-tokens`); иначе эвристика. */
  profileTokens?: number;
  /** Размер блока задачи в токенах (`--task-tokens`); иначе эвристика. */
  taskTokens?: number;
}

/** Разбирает значение флага как положительное целое или бросает понятную ошибку. */
function parsePositiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} требует положительное целое, получено: ${value}`);
  }
  return parsed;
}

/**
 * Читает JSON-схему из файла и оборачивает её в строгий response_format.
 * Файл должен содержать саму JSON Schema (объект); strict включается всегда.
 */
function loadJsonSchema(path: string): ResponseFormat {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Не удалось прочитать файл схемы: ${path}`);
  }

  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(raw);
  } catch {
    throw new Error(`Невалидный JSON в файле схемы: ${path}`);
  }

  return { type: 'json_schema', json_schema: { name: 'response', strict: true, schema } };
}

/**
 * Разбирает аргументы (без `node` и имени скрипта): флаги `--max-tokens`,
 * `--stop` (можно повторять), `--json`, `--json-schema`, `--no-thinking`,
 * `--temperature` и `--context-tokens` задают параметры запроса, остальное —
 * слова промпта. Значение флага можно писать как `--flag=value` или `--flag value`.
 */
export function parseArgs(args: string[]): ParsedArgs {
  const promptParts: string[] = [];
  const stops: string[] = [];
  const files: string[] = [];
  const limits: GenerationLimits = {};
  let disableThinking = false;
  let temperature: number | undefined;
  let contextTokens: number | undefined;
  let stream = true;
  let ephemeral = false;
  let switchTo: string | undefined;
  let branchName: string | undefined;
  let memory: MemoryKind = 'window';
  let keepRecent = DEFAULT_KEEP_RECENT;
  let noMemory = false;
  let task: string | undefined;
  let profile: string | undefined;
  let profileTokens: number | undefined;
  let taskTokens: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      promptParts.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);

    if (name === '--json') {
      limits.responseFormat = { type: 'json_object' };
      continue;
    }
    if (name === '--no-thinking') {
      disableThinking = true;
      continue;
    }
    if (name === '--no-stream') {
      stream = false;
      continue;
    }
    if (name === '--ephemeral') {
      ephemeral = true;
      continue;
    }
    if (name === '--no-memory') {
      noMemory = true;
      continue;
    }
    if (name === '--switch') {
      // Без значения — последняя ветка; иначе имя/id (через `=`).
      switchTo = eq === -1 ? 'last' : arg.slice(eq + 1);
      continue;
    }

    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined) {
      throw new Error(`Не указано значение для ${name}`);
    }

    if (name === '--max-tokens') {
      limits.maxTokens = parsePositiveInteger(name, value);
    } else if (name === '--context-tokens') {
      contextTokens = parsePositiveInteger(name, value);
    } else if (name === '--stop') {
      stops.push(value);
    } else if (name === '--file') {
      files.push(value);
    } else if (name === '--memory') {
      if (value !== 'window' && value !== 'summary' && value !== 'facts') {
        throw new Error(`--memory требует window, summary или facts, получено: ${value}`);
      }
      memory = value;
    } else if (name === '--keep-recent') {
      keepRecent = parsePositiveInteger(name, value);
    } else if (name === '--branch') {
      branchName = value;
    } else if (name === '--task') {
      task = value;
    } else if (name === '--profile') {
      profile = value;
    } else if (name === '--profile-tokens') {
      profileTokens = parsePositiveInteger(name, value);
    } else if (name === '--task-tokens') {
      taskTokens = parsePositiveInteger(name, value);
    } else if (name === '--json-schema') {
      limits.responseFormat = loadJsonSchema(value);
    } else if (name === '--temperature') {
      const parsed = validTemperature(value);
      if (parsed === null) {
        throw new Error(`--temperature требует неотрицательное число, получено: ${value}`);
      }
      temperature = parsed;
    } else {
      throw new Error(`Неизвестный флаг: ${name}`);
    }
  }

  if (stops.length > 0) {
    limits.stop = stops.length === 1 ? stops[0] : stops;
  }

  return {
    prompt: promptParts.join(' ').trim(),
    limits,
    disableThinking,
    temperature,
    contextTokens,
    stream,
    ephemeral,
    switchTo,
    branchName,
    files,
    memory,
    keepRecent,
    noMemory,
    task,
    profile,
    profileTokens,
    taskTokens,
  };
}
