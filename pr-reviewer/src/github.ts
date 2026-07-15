import { fileFromPatch } from './diff.ts';
import type { DiffFile, FileStatus } from './diff.ts';
import { requestJson } from './platform.ts';
import type { FetchLike, ReviewPlatform, PullChanges, ReviewPublication } from './platform.ts';
import type { ExistingComment } from './idempotency.ts';

/** Настройки GitHub-адаптера. */
export interface GithubDeps {
  fetchFn: FetchLike;
  /** База API: `https://api.github.com` или `https://ghe.corp/api/v3` (Enterprise). */
  apiBaseUrl: string;
  /** `owner/name`. */
  repo: string;
  prNumber: number;
  token: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  sleep: (ms: number) => Promise<void>;
}

/** Файлов PR на страницу и потолок страниц (защита от гигантских PR; усечение помечается честно). */
const PER_PAGE = 100;
const MAX_PAGES = 30;

/** Статус файла из GitHub API → наш `FileStatus`. */
function mapStatus(status: unknown, hasPatch: boolean): FileStatus {
  if (status === 'added') return 'added';
  if (status === 'removed') return 'removed';
  if (status === 'renamed') return 'renamed';
  // modified/changed/copied/unchanged: без patch (бинарник/слишком большой) — помечаем binary.
  return hasPatch ? 'modified' : 'binary';
}

/** Заголовки запроса к GitHub API. */
function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ai-advent-pr-reviewer',
    'Content-Type': 'application/json',
  };
}

/** Одна запись файла из ответа `pulls/{n}/files`. */
interface GithubFile {
  filename?: unknown;
  status?: unknown;
  patch?: unknown;
  previous_filename?: unknown;
}

/** DiffFile из записи API (patch может отсутствовать — бинарник/большой файл). */
function toDiffFile(raw: GithubFile): DiffFile | null {
  if (typeof raw.filename !== 'string' || raw.filename === '') {
    return null;
  }
  const patch = typeof raw.patch === 'string' ? raw.patch : '';
  const status = mapStatus(raw.status, patch !== '');
  const oldPath = typeof raw.previous_filename === 'string' ? raw.previous_filename : undefined;
  return fileFromPatch(raw.filename, patch, status, oldPath);
}

/** Создаёт GitHub-платформу. Один сервер API обслуживает и github.com, и Enterprise (base URL). */
export function createGithubPlatform(deps: GithubDeps): ReviewPlatform {
  const request = (method: string, path: string, body?: unknown): Promise<unknown> =>
    requestJson({
      fetchFn: deps.fetchFn,
      method,
      url: `${deps.apiBaseUrl}/repos/${deps.repo}${path}`,
      headers: headers(deps.token),
      ...(body === undefined ? {} : { body }),
      timeoutMs: deps.timeoutMs,
      maxRetries: deps.maxRetries,
      retryBaseMs: deps.retryBaseMs,
      sleep: deps.sleep,
    });

  return {
    async fetchChanges(): Promise<PullChanges> {
      const pull = (await request('GET', `/pulls/${deps.prNumber}`)) as {
        title?: unknown;
        body?: unknown;
      };
      const files: DiffFile[] = [];
      let page = 1;
      let truncated = false;
      for (;;) {
        const batch = (await request(
          'GET',
          `/pulls/${deps.prNumber}/files?per_page=${PER_PAGE}&page=${page}`,
        )) as GithubFile[];
        if (!Array.isArray(batch) || batch.length === 0) {
          break;
        }
        for (const raw of batch) {
          const file = toDiffFile(raw);
          if (file !== null) {
            files.push(file);
          }
        }
        if (batch.length < PER_PAGE) {
          break;
        }
        page++;
        if (page > MAX_PAGES) {
          truncated = true;
          break;
        }
      }
      return {
        title: typeof pull.title === 'string' ? pull.title : '',
        description: typeof pull.body === 'string' ? pull.body : '',
        files,
        truncated,
      };
    },

    async fetchExistingComments(): Promise<ExistingComment[]> {
      const comments: ExistingComment[] = [];
      let page = 1;
      for (;;) {
        const batch = (await request(
          'GET',
          `/pulls/${deps.prNumber}/comments?per_page=${PER_PAGE}&page=${page}`,
        )) as { id?: unknown; path?: unknown; line?: unknown; body?: unknown }[];
        if (!Array.isArray(batch) || batch.length === 0) {
          break;
        }
        for (const raw of batch) {
          if (typeof raw.id === 'number' && typeof raw.path === 'string') {
            comments.push({
              id: raw.id,
              path: raw.path,
              line: typeof raw.line === 'number' ? raw.line : null,
              body: typeof raw.body === 'string' ? raw.body : '',
            });
          }
        }
        if (batch.length < PER_PAGE || page >= MAX_PAGES) {
          break;
        }
        page++;
      }
      return comments;
    },

    async deleteComments(ids: number[]): Promise<void> {
      for (const id of ids) {
        await request('DELETE', `/pulls/comments/${id}`);
      }
    },

    async publish(review: ReviewPublication): Promise<void> {
      await request('POST', `/pulls/${deps.prNumber}/reviews`, {
        event: 'COMMENT',
        body: review.summary,
        comments: review.comments.map(comment => ({
          path: comment.file,
          line: comment.line,
          side: 'RIGHT',
          body: comment.body,
        })),
      });
    },
  };
}
