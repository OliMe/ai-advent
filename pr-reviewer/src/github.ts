import { fileFromPatch } from './diff.ts';
import type { DiffFile, FileStatus } from './diff.ts';
import { requestJson } from './platform.ts';
import type { FetchLike, ReviewPlatform, PullChanges, ReviewPublication } from './platform.ts';
import { hasAiMarker } from './idempotency.ts';

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

/** Записей на страницу и потолок страниц (защита от гигантских PR; усечение помечается честно). */
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

/** Комментарий с id и телом из API (инлайн или issue). */
interface RawComment {
  id?: unknown;
  body?: unknown;
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

  /** Все записи постраничного GET (для файлов и комментариев). */
  async function fetchAllPages(pathBase: string): Promise<unknown[]> {
    const items: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await request('GET', `${pathBase}?per_page=${PER_PAGE}&page=${page}`);
      if (!Array.isArray(batch) || batch.length === 0) {
        break;
      }
      items.push(...batch);
      if (batch.length < PER_PAGE) {
        break;
      }
    }
    return items;
  }

  /** id наших комментариев (по маркеру) в постраничной выборке. */
  async function ownMarkedIds(pathBase: string): Promise<number[]> {
    const raw = (await fetchAllPages(pathBase)) as RawComment[];
    return raw
      .filter(
        item =>
          typeof item.id === 'number' && typeof item.body === 'string' && hasAiMarker(item.body),
      )
      .map(item => item.id as number);
  }

  return {
    async fetchChanges(): Promise<PullChanges> {
      const pull = (await request('GET', `/pulls/${deps.prNumber}`)) as {
        title?: unknown;
        body?: unknown;
      };
      const raw = (await fetchAllPages(`/pulls/${deps.prNumber}/files`)) as GithubFile[];
      const files: DiffFile[] = [];
      for (const item of raw) {
        const file = toDiffFile(item);
        if (file !== null) {
          files.push(file);
        }
      }
      return {
        title: typeof pull.title === 'string' ? pull.title : '',
        description: typeof pull.body === 'string' ? pull.body : '',
        files,
        // Усечение: собрано ровно максимум записей (потолок страниц исчерпан).
        truncated: raw.length >= PER_PAGE * MAX_PAGES,
      };
    },

    /**
     * Идемпотентная публикация. Инлайн-комментарии — отдельными (удаляемыми) комментариями: свои
     * прежние снимаем, ставим актуальные. Сводка — ЕДИНСТВЕННЫЙ issue-комментарий: обновляем на месте
     * (PATCH), лишние свои удаляем, нет — создаём. Так повторный прогон не плодит ни дублей у строк,
     * ни стопки «reviewed»-сводок (submitted-ревью через API не удаляются — потому их не используем).
     */
    async publish(review: ReviewPublication): Promise<void> {
      // Свежий head-SHA — привязка инлайн-комментариев к нужному коммиту.
      const pull = (await request('GET', `/pulls/${deps.prNumber}`)) as {
        head?: { sha?: unknown };
      };
      const headSha = typeof pull.head?.sha === 'string' ? pull.head.sha : undefined;

      // Снять свои прежние инлайн-комментарии.
      for (const id of await ownMarkedIds(`/pulls/${deps.prNumber}/comments`)) {
        await request('DELETE', `/pulls/comments/${id}`);
      }

      // Сводка: обновить единственный свой issue-комментарий (лишние удалить), иначе создать.
      const summaryIds = await ownMarkedIds(`/issues/${deps.prNumber}/comments`);
      if (summaryIds.length === 0) {
        await request('POST', `/issues/${deps.prNumber}/comments`, { body: review.summary });
      } else {
        await request('PATCH', `/issues/comments/${summaryIds[0]}`, { body: review.summary });
        for (const extra of summaryIds.slice(1)) {
          await request('DELETE', `/issues/comments/${extra}`);
        }
      }

      // Поставить актуальные инлайн-комментарии (нужен head-SHA — иначе привязать не к чему).
      if (headSha !== undefined) {
        for (const comment of review.comments) {
          await request('POST', `/pulls/${deps.prNumber}/comments`, {
            commit_id: headSha,
            path: comment.file,
            line: comment.line,
            side: 'RIGHT',
            body: comment.body,
          });
        }
      }
    },
  };
}
