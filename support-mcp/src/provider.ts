import type { FetchLike } from '../../core/src/index.ts';
import type { SupportConfig } from './config.ts';
import type { Ticket, TicketComment } from './types.ts';
import { createGithubTicketProvider } from './provider-github.ts';

/**
 * Шов доступа к тикет-системе. Ассистент общается ТОЛЬКО с этим контрактом, поэтому под любой
 * трекер/CRM достаточно нового провайдера — код инструментов/бота не меняется.
 */
export interface TicketProvider {
  /** Один тикет по идентификатору. */
  getTicket(id: number): Promise<Ticket>;
  /** Открытые тикеты (до limit). */
  listTickets(limit: number): Promise<Ticket[]>;
  /** Поиск тикетов по тексту (до limit). */
  searchTickets(query: string, limit: number): Promise<Ticket[]>;
  /** Комментарии треда тикета (диалог поддержки). */
  getComments(id: number): Promise<TicketComment[]>;
  /** Добавить комментарий в тред тикета; возвращает созданный. */
  addComment(id: number, body: string): Promise<TicketComment>;
}

/**
 * Выбирает провайдера по конфигу. Пока единственный — GitHub Issues; чтобы добавить
 * GitLab/Jira/Zendesk/JSON, здесь появится ветка по `config.provider` (+ свой `provider-*.ts`).
 */
export function createProvider(
  config: SupportConfig,
  fetchFn: FetchLike,
  sleep: (ms: number) => Promise<void>,
): TicketProvider {
  return createGithubTicketProvider(config, fetchFn, sleep);
}
