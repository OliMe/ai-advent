import type { IndexedChunk } from '../../rag/src/index.ts';
import type { ChatComplete } from './rewrite.ts';

/**
 * Определение языка документации по индексу — для кросс-язычного rewrite (перевод запроса и HyDE на
 * язык корпуса). Приоритет: явный оверрайд `RAG_DOC_LANG` → закэшированный `index.language` → LLM-детект
 * (точный, игнорирует код; результат дозаписывается в кэш) → эвристика по письменности (без модели).
 */

/** Системная персона детектора: язык ЧЕЛОВЕЧЕСКОЙ документации, а не код. */
export const LANGUAGE_DETECT_SYSTEM =
  'Ты определяешь ОСНОВНОЙ человеческий язык документации репозитория. Тебе дают выдержки из его ' +
  'файлов. Игнорируй код, идентификаторы, команды, флаги и имена файлов — смотри только на связный ' +
  'человеческий текст (описания, README, комментарии). Ответь РОВНО ОДНИМ словом — английским ' +
  'названием языка (например: English, Russian, German, French, Spanish). Без пояснений и знаков.';

/** Нормализует ответ модели к одному слову-названию языка (буквы/дефис); не распознан — пустая строка. */
export function parseLanguageReply(reply: string): string {
  // split по пробелам всегда даёт ≥1 элемент (для '' — ['']), поэтому [0] — строка, без защиты.
  const first = reply.trim().split(/\s+/)[0];
  return first.replace(/[^\p{L}-]/gu, '');
}

/**
 * Эвристика по письменности (фолбэк без модели): чего больше в выборке — кириллицы или латиницы.
 * Грубо (латиница → English, кириллица → Russian), но детерминированно и ровно бьёт по случаю RU↔EN.
 */
export function detectLanguageByScript(samples: string[]): string {
  const text = samples.join(' ');
  let cyrillic = 0;
  let latin = 0;
  for (const character of text) {
    if (/[А-Яа-яЁё]/.test(character)) {
      cyrillic += 1;
    } else if (/[A-Za-z]/.test(character)) {
      latin += 1;
    }
  }
  return cyrillic > latin ? 'Russian' : 'English';
}

/**
 * Выборка чанков для детекта: предпочитает ПРОЗУ (`.md`/README/docs) над кодом — в коде много
 * английских идентификаторов, они исказили бы язык человеческих доков. Нет прозы — берём что есть.
 */
export function pickProseSamples(chunks: IndexedChunk[], limit = 12, perChunk = 400): string[] {
  const isProse = (chunk: IndexedChunk): boolean =>
    /\.(md|markdown|mdx|rst|txt|adoc)$/i.test(chunk.file) || /readme/i.test(chunk.file);
  const prose = chunks.filter(isProse);
  const pool = prose.length > 0 ? prose : chunks;
  return pool.slice(0, limit).map(chunk => chunk.text.slice(0, perChunk));
}

/** Параметры разрешения языка документации. */
export interface ResolveDocLanguageOptions {
  /** Явный оверрайд из конфига (`RAG_DOC_LANG`); задан — используем как есть. */
  override?: string;
  /** Закэшированный в индексе язык (`index.language`); задан — используем без вызова модели. */
  cachedLanguage?: string;
  /** Чанки индекса — из них берётся выборка для детекта. */
  chunks: IndexedChunk[];
  /** Chat-обращение для LLM-детекта; не задано — сразу эвристика по письменности. */
  chatComplete?: ChatComplete;
}

/** Результат: язык + откуда он взят (для наблюдаемости и решения «дозаписывать ли в кэш»). */
export interface DocLanguageResult {
  language: string;
  source: 'override' | 'cache' | 'model' | 'script';
}

/**
 * Разрешает язык документации по приоритету override → cache → LLM → письменность. LLM-ветка
 * (точная, игнорирует код) зовётся лишь при наличии модели и непустой выборки; сбой/пустой ответ —
 * откат на эвристику. Дозапись в кэш делает вызывающий (только для source `model` — эвристику
 * пересчитать бесплатно, кэшировать её незачем и вредно, если позже появится модель).
 */
export async function resolveDocLanguage(
  options: ResolveDocLanguageOptions,
): Promise<DocLanguageResult> {
  const override = options.override?.trim();
  if (override) {
    return { language: override, source: 'override' };
  }
  const cached = options.cachedLanguage?.trim();
  if (cached) {
    return { language: cached, source: 'cache' };
  }
  const samples = pickProseSamples(options.chunks);
  if (options.chatComplete !== undefined && samples.length > 0) {
    try {
      const reply = await options.chatComplete(LANGUAGE_DETECT_SYSTEM, samples.join('\n---\n'));
      const language = parseLanguageReply(reply);
      if (language !== '') {
        return { language, source: 'model' };
      }
    } catch {
      // Модель недоступна/ошиблась — тихо падаем на эвристику по письменности.
    }
  }
  return { language: detectLanguageByScript(samples), source: 'script' };
}
