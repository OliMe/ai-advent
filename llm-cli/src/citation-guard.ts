import type { Conversation } from '../../core/src/index.ts';
import type { SearchChunk } from './rag-answer.ts';
import { parseSearchResult } from './rag-answer.ts';
import { enforceFaithfulness } from './faithfulness.ts';

/** Ответ при слабом/пустом контексте (режим «не знаю»). */
export const RAG_DONT_KNOW =
  'Не знаю: в найденных источниках недостаточно контекста, чтобы ответить. ' +
  'Уточните запрос или укажите, где искать.';

/** Фолбэк, когда ответ так и не удалось подтвердить дословными цитатами. */
export const RAG_UNVERIFIED =
  'Не могу подтвердить ответ дословными цитатами из источников. Уточните запрос.';

/** Максимальная длина одной цитаты (символов) — выдержка, но реальные абзацы доков бывают длинными. */
const MAX_CITATION_LENGTH = 500;

/**
 * Нормализует текст для дословной сверки: снимает markdown-разметку и кавычки, схлопывает
 * пробелы/переносы, приводит к нижнему регистру. Чанк и цитату нормализуем одинаково — тогда
 * дословность не ломается на переносах строк и обрамлении цитаты.
 */
export function normalizeForMatch(text: string): string {
  // Оставляем только буквы/цифры, любую пунктуацию/пробелы → один пробел. Так «дословность» —
  // это «те же слова подряд», устойчиво к тому, что модель «облагораживает» кавычки/тире/точки
  // (« » „ " — . `). Обе стороны нормализуем одинаково, поэтому сверка остаётся честной: выдуманную
  // цитату (другие слова) это НЕ пропустит.
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Снимает ведущие маркеры списка/цитаты/markdown с элемента секции. */
function cleanItem(line: string): string {
  return line
    .replace(/^[\s*#>\-•]+/, '')
    .replace(/[`*]/g, '')
    .trim();
}

/** Тип секции по строке-заголовку (после снятия markdown). */
function sectionHeader(
  line: string,
): { section: 'sources' | 'citations' | 'answer'; rest: string } | null {
  const cleaned = line.replace(/^[\s*#>\-]+/, '').toLowerCase();
  // [а-яё]* — \w не матчит кириллицу, «источники» иначе режется на «источник»+«и:».
  const match = cleaned.match(/^(ответ|источник|цитат)[а-яё]*\s*([:：])?\s*(.*)$/);
  if (!match) {
    return null;
  }
  const rest = match[3];
  // Заголовок — либо «keyword:», либо ОДИНОЧНОЕ слово-заголовок (markdown «## Источники» без
  // двоеточия). «цитата один» (без двоеточия, но с продолжением) заголовком НЕ считаем.
  if (match[2] === undefined && rest !== '') {
    return null;
  }
  if (match[1].startsWith('источник')) {
    return { section: 'sources', rest };
  }
  if (match[1].startsWith('цитат')) {
    return { section: 'citations', rest };
  }
  return { section: 'answer', rest };
}

/** Секции ответа: строки списков «Источники» и «Цитаты» (без тела «Ответ»). */
export function parseAnswerSections(answer: string): { sources: string[]; citations: string[] } {
  const sources: string[] = [];
  const citations: string[] = [];
  let section: 'sources' | 'citations' | 'answer' | null = null;
  const push = (target: 'sources' | 'citations' | 'answer' | null, item: string) => {
    if (item === '') {
      return;
    }
    if (target === 'sources') {
      sources.push(item);
    } else if (target === 'citations') {
      citations.push(item);
    }
  };
  for (const raw of answer.split('\n')) {
    const header = sectionHeader(raw.trim());
    if (header) {
      section = header.section;
      push(section, cleanItem(header.rest));
      continue;
    }
    push(section, cleanItem(raw.trim()));
  }
  return { sources, citations };
}

/** Результат локальной проверки цитат/источников. */
export interface CitationValidation {
  ok: boolean;
  /** Причина отказа (для перегенерации); при ok — пустая. */
  reason: string;
}

/**
 * Локальная (без LLM) проверка анти-галлюцинаций: заявленные источники — среди реально найденных,
 * есть ≥1 цитата, каждая цитата — дословная (нормализованная) подстрока одного из чанков хода и не
 * длиннее лимита. Подделать цитату/источник нельзя — строковая сверка, а не суждение модели.
 */
export function validateCitations(answer: string, chunks: SearchChunk[]): CitationValidation {
  const { sources, citations } = parseAnswerSections(answer);
  if (sources.length === 0) {
    return { ok: false, reason: 'нет секции «Источники» или она пуста' };
  }
  if (citations.length === 0) {
    return { ok: false, reason: 'нет секции «Цитаты» или она пуста' };
  }
  // Собираем ВСЕ провалы за один проход (адресный фидбэк). Источники сверяем строго (все ⊂ найденных
  // — подделка источника недопустима); цитаты — мягче (День 25 п.2): весь ответ дословным НЕ требуем,
  // синтез/пересборка в теле — норма, нужен лишь ОДИН дословный якорь.
  const issues: string[] = [];
  // Источник заявлен корректно, если в строке упомянут реальный чанк — по file, source или chunk_id.
  for (const source of sources) {
    const haystack = normalizeForMatch(source);
    const known = chunks.some(chunk =>
      [chunk.file, chunk.source, chunk.chunk_id]
        .map(normalizeForMatch)
        // ≥3 символов — иначе одиночный токен (source «/d» → «d») ложно матчит любой источник.
        .some(needle => needle.length >= 3 && haystack.includes(needle)),
    );
    if (!known) {
      issues.push(`источник не найден среди найденных: «${source}»`);
    }
  }
  // Якорь: хотя бы одна цитата — дословная (нормализованная) подстрока фрагмента, не длиннее лимита.
  // Достаточно одного; остальные записи (синтез, собранные команды) терпим — их не бракуем.
  const chunkTexts = chunks.map(chunk => normalizeForMatch(chunk.text));
  const hasAnchor = citations.some(citation => {
    if (citation.length > MAX_CITATION_LENGTH) {
      return false;
    }
    const normalized = normalizeForMatch(citation);
    return chunkTexts.some(text => text.includes(normalized));
  });
  if (!hasAnchor) {
    issues.push(
      'нет ни одной дословной цитаты-якоря — приведи ≥1 РЕАЛЬНУЮ выдержку (дословную подстроку ' +
        'найденного фрагмента)',
    );
  }
  if (issues.length > 0) {
    return { ok: false, reason: issues.join('; ') };
  }
  return { ok: true, reason: '' };
}

/** Параметры цитатного гейта. */
export interface EnforceCitationsOptions {
  /** Уже сгенерированный ответ агента (проверяется первым, без перегенерации). */
  initial: string;
  /** Чанки хода (объединение всех результатов search_docs) — против них сверяем цитаты. */
  chunks: SearchChunk[];
  /** Перегенерация ответа с замечанием проверки. */
  regenerate: (feedback: string) => Promise<string>;
  /** Сколько перегенераций допустимо (по умолчанию 5). */
  maxRegenerations?: number;
  /** Колбэк на провал проверки (для печати): причина + номер попытки. */
  onFailure?: (reason: string, attempt: number) => void;
  /** Что вернуть, если так и не подтвердилось (по умолчанию RAG_UNVERIFIED). */
  fallback?: string;
}

/**
 * Гейт цитат: проверяет ответ локально; при провале называет причину и заставляет перегенерировать
 * (до maxRegenerations раз). Не сошлось — возвращает безопасный фолбэк (не непроверенный ответ).
 */
export async function enforceCitations(options: EnforceCitationsOptions): Promise<string> {
  const max = options.maxRegenerations ?? 5;
  const fallback = options.fallback ?? RAG_UNVERIFIED;
  let text = options.initial;
  for (let attempt = 0; attempt <= max; attempt++) {
    const check = validateCitations(text, options.chunks);
    if (check.ok) {
      return text;
    }
    options.onFailure?.(check.reason, attempt + 1);
    if (attempt < max) {
      text = await options.regenerate(citationFeedback(check.reason));
    }
  }
  return fallback;
}

/**
 * Замечание для перегенерации: называет КОНКРЕТНЫЕ провалы (адресно) и даёт жёсткий шаблон
 * трёх секций. Частый провал — модель вовсе опускает Источники/Цитаты; явный образец формата
 * надёжнее общей просьбы «перепиши в формате».
 */
export function citationFeedback(reason: string): string {
  return (
    `Проверка цитат не пройдена: ${reason}.\n` +
    'Ответ ОБЯЗАН содержать ровно три секции в таком виде:\n' +
    'Ответ: <твой ответ>\n' +
    'Источники:\n- <source › section · chunk_id>\n' +
    'Цитаты:\n- «<дословная выдержка из фрагмента>»\n' +
    'Источники — только реально приведённые ниже; цитаты — ТОЛЬКО дословные подстроки этих ' +
    'фрагментов (скопируй символ в символ). Исправь каждый названный выше провал.'
  );
}

/**
 * Итоговый ответ RAG-хода: разбирает результаты search_docs за ход; при пустом контексте или слабой
 * уверенности (все результаты low) → «не знаю» (без требования цитат); иначе → цитатный гейт против
 * объединения чанков хода. Вся ветвящаяся логика здесь (тестируемо), в интерактиве — один вызов.
 */
export async function resolveRagAnswer(options: {
  ragResults: string[];
  /**
   * Доказательства помимо RAG — фрагменты КОДА, прочитанные инструментами (День 31). Код в индекс не
   * кладётся, поэтому ответ о коде не мог бы сослаться ни на что и гейт валил бы его; здесь код
   * становится таким же проверяемым доказательством, как фрагмент документации.
   */
  extraChunks?: SearchChunk[];
  initial: string;
  regenerate: (feedback: string) => Promise<string>;
  onFailure?: (reason: string, attempt: number) => void;
  /** Опциональный рантайм-гейт достоверности (LLM-судья) поверх локального; отсутствует — выключен. */
  faithfulness?: {
    makeChecker: () => Conversation;
    onUnfaithful?: (issues: string[], attempt: number) => void;
  };
}): Promise<string> {
  const parsed = options.ragResults.map(parseSearchResult);
  const extraChunks = options.extraChunks ?? [];
  const chunks = [...parsed.flatMap(result => result.chunks), ...extraChunks];
  const allLow = parsed.length > 0 && parsed.every(result => result.lowConfidence);
  // «Не знаю» — когда доказательств нет вовсе: ни фрагментов, ни кода. Слабый док-контекст сам по
  // себе не повод молчать, если ответ опирается на прочитанный код (он добыт точечно, не ранжирован).
  if (chunks.length === 0 || (allLow && extraChunks.length === 0)) {
    return RAG_DONT_KNOW;
  }
  const local = await enforceCitations({
    initial: options.initial,
    chunks,
    regenerate: options.regenerate,
    onFailure: options.onFailure,
  });
  // Гейт достоверности — только если включён и локальный гейт дал реальный ответ (не фолбэк).
  if (options.faithfulness === undefined || local === RAG_UNVERIFIED) {
    return local;
  }
  return enforceFaithfulness({
    initial: local,
    chunks,
    makeChecker: options.faithfulness.makeChecker,
    regenerate: options.regenerate,
    fallback: RAG_UNVERIFIED,
    onUnfaithful: options.faithfulness.onUnfaithful,
  });
}
