import type { Conversation } from '../../core/src/index.ts';
import type { SearchChunk } from './rag-answer.ts';

/** Системная персона судьи достоверности: сверяет утверждения ответа с фрагментами-источниками. */
export const FAITHFULNESS_CHECKER_SYSTEM =
  'Ты — контролёр достоверности RAG-ответа. Тебе дают ФРАГМЕНТЫ-источники и ОТВЕТ ассистента. ' +
  'Проверь, что КАЖДОЕ фактическое утверждение ответа прямо следует из фрагментов (ничего не ' +
  'додумано сверх них). Если всё подкреплено — ответь ровно «OK». Если есть утверждения без опоры ' +
  'на фрагменты — перечисли их по одному, каждое с новой строки, без слова «OK».';

/** Вердикт судьи: подкреплён ли ответ фрагментами + список неподкреплённых утверждений. */
export function parseFaithfulnessVerdict(content: string): { faithful: boolean; issues: string[] } {
  const trimmed = content.trim();
  // «OK» (или пусто) — ответ достоверен; иначе перечислены неподкреплённые утверждения.
  if (trimmed === '' || /^ok\b/i.test(trimmed)) {
    return { faithful: true, issues: [] };
  }
  const issues = trimmed
    .split('\n')
    .map(line => line.replace(/^[-*•\s]+/, '').trim())
    .filter(line => line !== '');
  return { faithful: issues.length === 0, issues };
}

/** Спрашивает судью: опирается ли ответ на фрагменты. Свежий диалог на каждую проверку. */
async function checkFaithfulness(
  makeChecker: () => Conversation,
  chunks: SearchChunk[],
  answer: string,
): Promise<{ faithful: boolean; issues: string[] }> {
  const fragments = chunks.map((chunk, index) => `[${index + 1}] ${chunk.text}`).join('\n\n');
  const result = await makeChecker().ask(
    `Фрагменты-источники:\n${fragments}\n\nОтвет на проверку:\n${answer}`,
  );
  return parseFaithfulnessVerdict(result.content);
}

/** Параметры гейта достоверности (опциональный рантайм-слой поверх локального гейта цитат). */
export interface EnforceFaithfulnessOptions {
  /** Локально валидный ответ (уже прошёл гейт цитат) — проверяется первым. */
  initial: string;
  /** Чанки хода — их судья видит как источники. */
  chunks: SearchChunk[];
  /** Фабрика свежего диалога судьи (низкая температура). */
  makeChecker: () => Conversation;
  /** Перегенерация ответа с замечанием судьи. */
  regenerate: (feedback: string) => Promise<string>;
  /** Что вернуть, если достоверность так и не подтвердилась. */
  fallback: string;
  /** Сколько перегенераций допустимо (по умолчанию 2). */
  maxRegenerations?: number;
  /** Колбэк на недостоверность (для печати): неподкреплённые утверждения + номер попытки. */
  onUnfaithful?: (issues: string[], attempt: number) => void;
}

/**
 * Гейт достоверности (LLM-судья): проверяет, что утверждения ответа опираются на фрагменты; при
 * провале называет неподкреплённое и заставляет перегенерировать (до maxRegenerations). Не сошлось —
 * безопасный фолбэк. В отличие от локального гейта цитат, это семантическая проверка — судья капризен,
 * поэтому слой ОПЦИОНАЛЬНЫЙ (тумблер) для сравнения «с ним и без».
 */
export async function enforceFaithfulness(options: EnforceFaithfulnessOptions): Promise<string> {
  const max = options.maxRegenerations ?? 2;
  let text = options.initial;
  for (let attempt = 0; attempt <= max; attempt++) {
    const verdict = await checkFaithfulness(options.makeChecker, options.chunks, text);
    if (verdict.faithful) {
      return text;
    }
    options.onUnfaithful?.(verdict.issues, attempt + 1);
    if (attempt < max) {
      text = await options.regenerate(
        `Ответ содержит утверждения без опоры на источники: ${verdict.issues.join('; ')}. ` +
          'Перепиши, опираясь ТОЛЬКО на приведённые фрагменты, в том же формате Ответ/Источники/Цитаты.',
      );
    }
  }
  return options.fallback;
}
