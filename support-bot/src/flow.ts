import type { ChatMessage, ToolSet } from '../../core/src/index.ts';
import type { SearchChunk } from '../../grounding/src/index.ts';
import { readTicketThread, postReply } from './ticket-client.ts';
import { formatTicketContext, pickQuestion } from './ticket-context.ts';
import { answerSupportQuestion } from './answer.ts';
import { buildSourceLinkContext, linkifySources } from './source-links.ts';

/** Зависимости потока ответа (инъекция — CRM через MCP, FAQ и модель подставляются). */
export interface SupportFlowDeps {
  /** ToolSet с подключённым support-mcp (CRM). */
  toolSet: ToolSet;
  /** Тикет, на который отвечаем. */
  issueId: number;
  /** Фрагменты FAQ по запросу (обычно `retrieveDocChunks` над кэшем). */
  retrieveFaq: (query: string) => Promise<SearchChunk[]>;
  /** Tool-free генерация синтеза. */
  complete: (messages: ChatMessage[]) => Promise<string>;
  /** Git-ref для ссылок на файлы FAQ (SHA/ветка); пусто → «Источники» без ссылок. */
  linkRef?: string;
  /** Корень репозитория для относительного пути файла в ссылке; пусто → без ссылок. */
  repoRoot?: string;
  onCitationFailure?: (reason: string, attempt: number) => void;
}

/** Результат потока: постили ли ответ и почему (для наблюдаемости/логов CI). */
export interface SupportFlowResult {
  posted: boolean;
  /** Причина, если НЕ постили (сработала защита петли). */
  reason?: string;
  question?: string;
  answer?: string;
}

/**
 * Детерминированный поток ответа поддержки: прочитать тред через MCP → защита от петли (последний
 * комментарий бота → ничего не делаем) → выбрать вопрос → FAQ по вопросу → синтез с цитатным гейтом →
 * запостить ответ обратно через MCP.
 */
export async function runSupportFlow(deps: SupportFlowDeps): Promise<SupportFlowResult> {
  const { ticket, comments } = await readTicketThread(deps.toolSet, deps.issueId);

  // Защита от петли: последний комментарий — уже наш ответ (по маркеру) → не отвечаем на себя.
  if (comments.length > 0 && comments[comments.length - 1].isBot) {
    return { posted: false, reason: 'последний комментарий — ответ бота (петля предотвращена)' };
  }

  const question = pickQuestion(ticket, comments);
  const faqChunks = await deps.retrieveFaq(question);
  const ticketContext = formatTicketContext(ticket, comments);
  const answer = await answerSupportQuestion(
    {
      complete: deps.complete,
      faqChunks,
      ticketContext,
      ...(deps.onCitationFailure === undefined
        ? {}
        : { onCitationFailure: deps.onCitationFailure }),
    },
    question,
  );

  // «Источники» → кликабельные ссылки на файл+раздел FAQ в репозитории (если известны ref и корень).
  const linkContext =
    deps.linkRef && deps.repoRoot
      ? buildSourceLinkContext(ticket.url, deps.linkRef, deps.repoRoot)
      : null;
  const linked = linkifySources(answer, faqChunks, linkContext);

  await postReply(deps.toolSet, deps.issueId, linked);
  return { posted: true, question, answer: linked };
}
