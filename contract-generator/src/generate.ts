import type { ChatCompletionClient, ChatMessage, GenerationLimits } from '../../core/src/index.ts';

/** Маркер конца договора — стоп-последовательность (здесь sentinel-stop работает «по полной»). */
const END_MARKER = '<<<КОНЕЦ>>>';

/** Открывающая часть маркера — по ней чистим текст на случай неполного маркера. */
const MARKER_HEAD = '<<<';

/**
 * Системный промпт намеренно стабилен (одинаков на всех вызовах) — провайдер
 * кэширует его, и повторные запросы почти не тратят входные токены.
 */
const SYSTEM_PROMPT =
  'Сгенерируй ОДИН синтетический договор аренды на русском языке. ' +
  'Включи только вводную часть с полными реквизитами обеих сторон ' +
  '(арендодатель и арендатор): наименование или ФИО, ИНН, ОГРН/ОГРНИП (если применимо), ' +
  'адрес, представитель и основание полномочий. Без прочего текста договора, кратко. ' +
  `Заверши ответ маркером ${END_MARKER}.`;

/** Сообщения для генерации одного договора; seed добавляет разнообразия. */
export function buildGenerationMessages(seed: number): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Договор №${seed}. Сделай стороны разнообразными: чередуй юридическое лицо, ` +
        'ИП и физлицо, используй разные города, наименования и реквизиты.',
    },
  ];
}

/** Ограничения генерации: стоп-маркер + лимит длины. */
export function generationLimits(maxTokens: number): GenerationLimits {
  return { maxTokens, stop: [END_MARKER] };
}

/**
 * Убирает стоп-маркер и обрезает пробелы. Режем от открывающей части `<<<`,
 * а не от полного `<<<КОНЕЦ>>>`: модель не всегда дописывает закрывающие символы,
 * и иначе обрывок маркера утёк бы в текст.
 */
export function cleanContract(raw: string): string {
  const markerAt = raw.indexOf(MARKER_HEAD);
  const text = markerAt === -1 ? raw : raw.slice(0, markerAt);
  return text.trim();
}

/**
 * Генерирует один договор. Рассуждения отключаются (`disableThinking`): это и
 * экономит токены (нет reasoning-токенов), и нужно для стоп-маркера — иначе у
 * GLM маркер всплывает в рассуждениях и обрывает генерацию.
 */
export async function generateOne(
  client: ChatCompletionClient,
  seed: number,
  maxTokens: number,
  requestTimeoutMs: number,
): Promise<string> {
  const signal = AbortSignal.timeout(requestTimeoutMs);
  const raw = await client.complete(buildGenerationMessages(seed), {
    signal,
    disableThinking: true,
    ...generationLimits(maxTokens),
  });
  return cleanContract(raw);
}

/** Разделитель договоров внутри ответа пакетного режима. */
const BATCH_DELIMITER = '=====';

/** Системный промпт пакетного режима (несколько договоров за один запрос). */
const BATCH_SYSTEM_PROMPT =
  'Ты генерируешь синтетические договоры аренды на русском языке. Для каждого включай ' +
  'только вводную часть с полными реквизитами обеих сторон (арендодатель и арендатор): ' +
  'наименование или ФИО, ИНН, ОГРН/ОГРНИП (если применимо), адрес, представитель, ' +
  'основание полномочий. Без прочего текста договора, кратко.';

/** Сообщения для генерации `count` договоров за один запрос. */
export function buildBatchMessages(count: number, seedBase: number): ChatMessage[] {
  return [
    { role: 'system', content: BATCH_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Сгенерируй ${count} разных договоров аренды (№${seedBase}–${seedBase + count - 1}). ` +
        `Раздели договоры строкой ${BATCH_DELIMITER} (и только ей). ` +
        'Стороны разнообразь: чередуй юридическое лицо, ИП и физлицо, разные города и реквизиты.',
    },
  ];
}

/** Делит ответ пакетного режима на отдельные договоры. */
export function parseBatch(raw: string): string[] {
  return raw
    .split(BATCH_DELIMITER)
    .map(part => part.trim())
    .filter(part => part.length > 0);
}

/**
 * Генерирует `count` договоров за ОДИН запрос (пакетный режим). Стоп-маркер не
 * используется — границы держит разделитель; лимит длины масштабируется на count.
 * Рассуждения отключены: экономит токены и делает вывод предсказуемее.
 */
export async function generateBatch(
  client: ChatCompletionClient,
  count: number,
  seedBase: number,
  maxTokensPerContract: number,
  requestTimeoutMs: number,
): Promise<string[]> {
  const signal = AbortSignal.timeout(requestTimeoutMs);
  const raw = await client.complete(buildBatchMessages(count, seedBase), {
    signal,
    disableThinking: true,
    maxTokens: maxTokensPerContract * count,
  });
  return parseBatch(raw);
}
