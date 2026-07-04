/** Один найденный фрагмент из результата search_docs (для рендера и сверки цитат). */
export interface SearchChunk {
  chunk_id: string;
  source: string;
  file: string;
  section: string;
  score: number;
  /** Тело чанка (может содержать пустые строки — важно для дословной сверки цитат). */
  text: string;
}

/** Разобранный результат search_docs: фрагменты + метрика уверенности ретрива. */
export interface ParsedSearchResult {
  chunks: SearchChunk[];
  /** Лучший косинус из трассы (null — не удалось прочитать). */
  confidence: number | null;
  /** Помечен ли контекст как слабый (пометка «(низкая)» или «⚠ Низкая уверенность»). */
  lowConfidence: boolean;
}

/** Заголовок фрагмента: `[n] chunk_id · source › file › section (score)`. */
const HEADER = /^\[\d+\]\s+(.+?)\s·\s(.+)\s\(([\d.]+)\)\s*$/;

/**
 * Толерантно разбирает текстовый результат search_docs в структуру. Границы фрагментов — по
 * ЗАГОЛОВКАМ (не по пустым строкам): тело чанка само может содержать пустые строки. Из заголовка
 * берём chunk_id и метку `source › file › section`; уверенность и флаг слабого контекста — из трассы.
 */
export function parseSearchResult(text: string): ParsedSearchResult {
  const confidenceMatch = text.match(/уверенность\s+([\d.]+)/);
  const confidence = confidenceMatch ? Number(confidenceMatch[1]) : null;
  const lowConfidence = text.includes('(низкая)') || text.includes('Низкая уверенность');
  const chunks: SearchChunk[] = [];
  let current: (Omit<SearchChunk, 'text'> & { body: string[] }) | null = null;
  const flush = () => {
    if (current) {
      const { body, ...rest } = current;
      chunks.push({ ...rest, text: body.join('\n').trim() });
    }
  };
  for (const line of text.split('\n')) {
    const match = HEADER.exec(line);
    if (match && match[2].includes(' › ')) {
      flush();
      const [source, file, ...sectionParts] = match[2].split(' › ');
      current = {
        chunk_id: match[1],
        source,
        file,
        section: sectionParts.join(' › '),
        score: Number(match[3]),
        body: [],
      };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return { chunks, confidence, lowConfidence };
}
