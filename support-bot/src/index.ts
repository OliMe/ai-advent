export { loadSupportBotConfig } from './config.ts';
export type { SupportBotConfig } from './config.ts';
export { readTicketThread, postReply } from './ticket-client.ts';
export { formatTicketContext, pickQuestion } from './ticket-context.ts';
export { SUPPORT_DIRECTIVE, answerSupportQuestion } from './answer.ts';
export type { SupportAnswerDeps } from './answer.ts';
export { runSupportFlow } from './flow.ts';
export type { SupportFlowDeps, SupportFlowResult } from './flow.ts';
export {
  repoWebBaseFromTicketUrl,
  buildSourceLinkContext,
  githubHeadingAnchor,
  linkifySources,
} from './source-links.ts';
export type { SourceLinkContext } from './source-links.ts';
