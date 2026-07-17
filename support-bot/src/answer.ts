import type { ChatMessage } from '../../core/src/index.ts';
import type { SearchChunk } from '../../grounding/src/index.ts';
import { resolveRagAnswer } from '../../grounding/src/index.ts';

/**
 * Директива ассистента поддержки: отвечать ТОЛЬКО по фрагментам FAQ, формат из трёх секций (его
 * проверяет цитатный гейт), «не знаю» если FAQ не покрывает вопрос. Тот же приём, что у `/ask` Дня 31.
 */
export const SUPPORT_DIRECTIVE =
  'Ты — ассистент поддержки пользователей. Ответь на вопрос ТОЛЬКО по приведённым ниже фрагментам ' +
  'FAQ и найденным местам в КОДЕ (если они есть), учитывая контекст тикета. Не выдумывай: чего нет в ' +
  'приведённых материалах — того не утверждай. Если материалы не покрывают вопрос — честно скажи, что ' +
  'нужно уточнение или помощь оператора.\n' +
  'Формат ответа — РОВНО три секции:\n' +
  'Ответ: <по существу, дружелюбно>\n' +
  'Источники:\n- <файл FAQ или файл кода, откуда взято>\n' +
  'Цитаты:\n- «<ДОСЛОВНАЯ выдержка из фрагмента FAQ или кода выше>»\n' +
  'Цитата обязана быть дословной подстрокой приведённого материала (скопируй символ в символ).';

/**
 * Снимает ведущий ярлык «Ответ:» из финального текста. Секция «Ответ» нужна модели и цитатному гейту
 * для формата трёх секций, но в опубликованном комментарии она избыточна (и так видно, что это ответ).
 * Убирается ТОЛЬКО ведущее вхождение (в т.ч. markdown-заголовок `## Ответ:`); «Источники»/«Цитаты» и
 * фолбэк «Не знаю…» не затрагиваются.
 */
export function stripAnswerLabel(text: string): string {
  return text.replace(/^\s*#{0,6}\s*\*{0,2}\s*ответ\s*\*{0,2}\s*[:：]\s*\*{0,2}\s*/iu, '');
}

/** Зависимости движка ответа (инъекция — для тестов без сети). */
export interface SupportAnswerDeps {
  /** Tool-free одиночная генерация (низкая температура) — синтез по собранным фрагментам. */
  complete: (messages: ChatMessage[]) => Promise<string>;
  /** Фрагменты FAQ по вопросу (цитируемые доказательства для гейта). */
  faqChunks: SearchChunk[];
  /** Контекст тикета (system-блок для подстройки; не цитируется). */
  ticketContext: string;
  /** Фрагменты КОДА (опц., тумблер `SUPPORT_CODE_SEARCH`) — такие же цитируемые доказательства. */
  codeChunks?: SearchChunk[];
  /** Готовые дословные строки-кандидаты из кода для секции «Цитаты» (опц.). */
  codeCandidates?: string[];
  /** Колбэк на провал цитатной проверки (для наблюдаемости). */
  onCitationFailure?: (reason: string, attempt: number) => void;
}

/** Рендер фрагментов документации/кода в текст для промпта. */
function renderChunks(chunks: SearchChunk[]): string {
  return chunks
    .map(chunk => `${chunk.file}${chunk.section ? ` › ${chunk.section}` : ''}\n${chunk.text}`)
    .join('\n\n');
}

/** Готовые дословные строки-кандидаты для секции «Цитаты» (первая непустая строка каждого фрагмента). */
function citationCandidates(chunks: SearchChunk[]): string[] {
  return chunks
    .map(
      chunk =>
        chunk.text
          .split('\n')
          .map(line => line.trim())
          .find(line => line.length > 0) ?? '',
    )
    .filter(line => line.length > 0)
    .slice(0, 5);
}

/**
 * Ответ поддержки: собирает контекст (директива + тикет + фрагменты FAQ + готовые цитаты) → tool-free
 * синтез → цитатный гейт (источники ⊂ FAQ + дословная цитата). Нет фрагментов FAQ → гейт вернёт «не
 * знаю» (честно, а не выдумка). Перегенерация — тоже tool-free, с исходным вопросом.
 */
export async function answerSupportQuestion(
  deps: SupportAnswerDeps,
  question: string,
): Promise<string> {
  const codeChunks = deps.codeChunks ?? [];
  const leading: ChatMessage[] = [
    { role: 'system', content: SUPPORT_DIRECTIVE },
    { role: 'system', content: deps.ticketContext },
  ];
  if (deps.faqChunks.length > 0) {
    leading.push({
      role: 'system',
      content: `Фрагменты FAQ (отвечай строго по ним):\n${renderChunks(deps.faqChunks)}`,
    });
  }
  if (codeChunks.length > 0) {
    leading.push({
      role: 'system',
      content: `Найденные места в КОДЕ (файл › инструмент):\n${renderChunks(codeChunks)}`,
    });
  }
  // Готовые дословные строки для «Цитат»: из FAQ + из кода — слабая модель пересказывает вместо
  // цитирования и валит гейт; «скопируй одну строку» ей посильно.
  const candidates = [...citationCandidates(deps.faqChunks), ...(deps.codeCandidates ?? [])];
  if (candidates.length > 0) {
    leading.push({
      role: 'system',
      content:
        'Готовые ДОСЛОВНЫЕ строки для секции «Цитаты» — скопируй в ответ хотя бы ОДНУ символ в ' +
        `символ:\n${candidates.map(candidate => `- «${candidate}»`).join('\n')}`,
    });
  }

  const outgoing: ChatMessage[] = [...leading, { role: 'user', content: question }];
  const initial = await deps.complete(outgoing);

  return resolveRagAnswer({
    ragResults: [],
    extraChunks: [...deps.faqChunks, ...codeChunks],
    initial,
    regenerate: async feedback =>
      deps.complete([
        ...outgoing,
        { role: 'user', content: `${feedback}\n\nОтвечай на ИСХОДНЫЙ вопрос: ${question}` },
      ]),
    ...(deps.onCitationFailure === undefined ? {} : { onFailure: deps.onCitationFailure }),
  });
}
