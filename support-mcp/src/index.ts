export type { Ticket, TicketComment, TicketUser } from './types.ts';
export { SUPPORT_MARKER, markComment, hasSupportMarker } from './loop-guard.ts';
export { loadSupportConfig } from './config.ts';
export type { SupportConfig, SupportProvider } from './config.ts';
export { createProvider } from './provider.ts';
export type { TicketProvider } from './provider.ts';
export { createGithubTicketProvider } from './provider-github.ts';
export {
  handleGetTicket,
  handleListTickets,
  handleSearchTickets,
  handleGetTicketComments,
  handleAddTicketComment,
} from './tools.ts';
export type { ToolDeps } from './tools.ts';
