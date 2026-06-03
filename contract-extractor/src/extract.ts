import type { ChatCompletionClient, ChatMessage, GenerationLimits } from '../../core/src/index.ts';
import { BATCH_SCHEMA, PARTIES_SCHEMA_SPEC, type ContractParties } from './parties.ts';

/**
 * Стоп-последовательность-страховка от «хвоста» после JSON. Модель НЕ просим её
 * печатать: у reasoning-моделей упоминание маркера в рассуждениях обрывает
 * генерацию досрочно. Здесь это безвредный предохранитель, а не часть протокола.
 */
const DONE_MARKER = '<<<DONE>>>';

/** Системный промпт строгого режима: роль + дублирование схемы (мягкая деградация). */
const STRICT_SYSTEM_PROMPT =
  'Ты извлекаешь реквизиты сторон (арендодатель и арендатор) из договоров аренды. ' +
  'Отвечай строго в виде JSON по этой JSON Schema, без markdown и пояснений:\n' +
  JSON.stringify(BATCH_SCHEMA, null, 2);

/**
 * Строит сообщения для строгого извлечения из пакета договоров.
 * Если нужно меньше объектов, чем договоров в пакете, просит вернуть только первые.
 */
export function buildExtractionMessages(contracts: string[], wantCount: number): ChatMessage[] {
  const numbered = contracts
    .map((contract, index) => `### Договор ${index + 1}\n${contract}`)
    .join('\n\n');
  const limitNote =
    wantCount < contracts.length
      ? `Верни объекты только для первых ${wantCount} договоров.`
      : 'Верни по объекту на каждый договор, по порядку.';

  return [
    { role: 'system', content: STRICT_SYSTEM_PROMPT },
    { role: 'user', content: `Извлеки реквизиты сторон. ${limitNote}\n\n${numbered}` },
  ];
}

/** Ограничения генерации строгого режима: лимит длины + json_schema + стоп-маркер. */
export function extractionLimits(maxTokens: number): GenerationLimits {
  return {
    maxTokens,
    responseFormat: { type: 'json_schema', json_schema: PARTIES_SCHEMA_SPEC },
    stop: [DONE_MARKER],
  };
}

/**
 * Разбирает ответ модели в массив реквизитов: берёт фрагмент от первой `{`
 * до последней `}` (отбрасывая возможные ограждения и маркеры) и парсит JSON.
 */
export function parseContracts(raw: string): ContractParties[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      'В ответе модели не найден JSON-объект — возможно, ответ обрезан по лимиту ' +
        '(увеличьте --max-tokens или добавьте --no-thinking).',
    );
  }

  let data: { contracts?: unknown };
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('Не удалось разобрать JSON из ответа модели');
  }

  if (!Array.isArray(data.contracts)) {
    throw new Error('В ответе модели нет поля contracts со списком договоров');
  }
  return data.contracts as ContractParties[];
}

/** Извлекает реквизиты из одного пакета договоров (строгий режим). */
export async function extractBatch(
  client: ChatCompletionClient,
  contracts: string[],
  wantCount: number,
  maxTokens: number,
  requestTimeoutMs: number,
  disableThinking: boolean,
): Promise<ContractParties[]> {
  const messages = buildExtractionMessages(contracts, wantCount);
  const signal = AbortSignal.timeout(requestTimeoutMs);
  const raw = await client.complete(messages, {
    signal,
    disableThinking,
    ...extractionLimits(maxTokens),
  });
  return parseContracts(raw);
}

/** Разделитель договоров внутри ответа свободного (текстового) режима. */
const LIST_DELIMITER = '<<<NEXT>>>';

/** Строит сообщения для свободного текстового режима (без ограничений формата). */
export function buildListMessages(contracts: string[]): ChatMessage[] {
  const numbered = contracts
    .map((contract, index) => `### Договор ${index + 1}\n${contract}`)
    .join('\n\n');

  return [
    {
      role: 'system',
      content:
        'Ты извлекаешь реквизиты сторон (арендодатель и арендатор) из договоров аренды ' +
        'и излагаешь их кратко и читаемо на русском языке.',
    },
    {
      role: 'user',
      content:
        'Для каждого договора ниже выпиши реквизиты сторон в удобочитаемом виде. ' +
        `Раздели договоры строкой ${LIST_DELIMITER} (и только ей).\n\n${numbered}`,
    },
  ];
}

/** Делит текстовый ответ свободного режима на блоки по договорам. */
export function parseList(raw: string): string[] {
  return raw
    .split(LIST_DELIMITER)
    .map(block => block.trim())
    .filter(block => block.length > 0);
}

/** Извлекает читаемые блоки реквизитов из одного пакета (свободный режим). */
export async function listBatch(
  client: ChatCompletionClient,
  contracts: string[],
  requestTimeoutMs: number,
): Promise<string[]> {
  const signal = AbortSignal.timeout(requestTimeoutMs);
  const raw = await client.complete(buildListMessages(contracts), { signal });
  return parseList(raw);
}
