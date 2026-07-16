export { commentableLinesOf, parseUnifiedDiff, fileFromPatch } from './diff.ts';
export type { FileStatus, DiffFile } from './diff.ts';
export { REVIEW_SCHEMA, SEVERITY_ORDER, coerceReviewResult } from './schema.ts';
export type { FindingSeverity, Finding, ReviewResult } from './schema.ts';
export { validateFindings } from './validate.ts';
export type { ValidatedFindings } from './validate.ts';
export { generateReview } from './review.ts';
export type { ReviewInput, ReviewDeps } from './review.ts';
export { groundDocs, warmDocsIndex, readChangedFiles } from './grounding.ts';
export type { GroundingDeps } from './grounding.ts';
export { computeIndexCacheKey, FileIndexCache } from './index-cache.ts';
export type { IndexCache, IndexCacheIo } from './index-cache.ts';
export { loadReviewConfig, parsePlatform, parseMinSeverity } from './config.ts';
export type { Platform, ReviewConfig } from './config.ts';
export { severityRank, meetsSeverity, dedupeFindings, postprocessFindings } from './postprocess.ts';
export type { PostprocessOptions } from './postprocess.ts';
export { requestJson } from './platform.ts';
export type {
  FetchLike,
  HttpResponse,
  PullChanges,
  InlineComment,
  ReviewPublication,
  ReviewPlatform,
  RequestOptions,
} from './platform.ts';
export { createGithubPlatform } from './github.ts';
export type { GithubDeps } from './github.ts';
export { renderComment, buildPublication } from './render.ts';
export { AI_REVIEW_MARKER, markComment, hasAiMarker, ownCommentIds } from './idempotency.ts';
export type { ApiComment } from './idempotency.ts';
