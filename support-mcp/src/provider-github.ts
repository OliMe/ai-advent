import { requestJson } from '../../core/src/index.ts';
import type { FetchLike } from '../../core/src/index.ts';
import type { SupportConfig } from './config.ts';
import type { TicketProvider } from './provider.ts';
import type { Ticket, TicketComment, TicketUser } from './types.ts';
import { hasSupportMarker } from './loop-guard.ts';

/** Записей на страницу и потолок страниц (защита от гигантских тредов). */
const PER_PAGE = 100;
const MAX_PAGES = 20;

/** Заголовки запроса к GitHub API. */
function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ai-advent-support',
    'Content-Type': 'application/json',
  };
}

/** Пользователь из ответа API. */
interface RawUser {
  login?: unknown;
  name?: unknown;
}

/** Issue из ответа API (pull_request присутствует только у PR — GitHub моделит их как issue). */
interface RawIssue {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  user?: RawUser;
  labels?: unknown;
  state?: unknown;
  html_url?: unknown;
  pull_request?: unknown;
}

/** Комментарий из ответа API. */
interface RawComment {
  id?: unknown;
  user?: RawUser;
  body?: unknown;
  created_at?: unknown;
}

/** Пользователь API → доменный (без имени поле опускаем). */
function mapUser(raw: RawUser | undefined): TicketUser {
  const login = typeof raw?.login === 'string' && raw.login !== '' ? raw.login : 'unknown';
  const displayName = typeof raw?.name === 'string' && raw.name !== '' ? raw.name : undefined;
  return displayName === undefined ? { login } : { login, displayName };
}

/** Имена меток из массива labels API. */
function mapLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map(label =>
      typeof (label as { name?: unknown }).name === 'string'
        ? ((label as { name: string }).name as string)
        : '',
    )
    .filter(name => name !== '');
}

/** Issue API → доменный Ticket. */
function mapIssue(raw: RawIssue): Ticket {
  return {
    id: typeof raw.number === 'number' ? raw.number : 0,
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    author: mapUser(raw.user),
    labels: mapLabels(raw.labels),
    state: typeof raw.state === 'string' ? raw.state : '',
    url: typeof raw.html_url === 'string' ? raw.html_url : '',
  };
}

/** Comment API → доменный TicketComment (бот распознаётся по маркеру в теле). */
function mapComment(raw: RawComment): TicketComment {
  const body = typeof raw.body === 'string' ? raw.body : '';
  return {
    id: typeof raw.id === 'number' ? raw.id : 0,
    author: mapUser(raw.user),
    body,
    createdAt: typeof raw.created_at === 'string' ? raw.created_at : '',
    isBot: hasSupportMarker(body),
  };
}

/** Это настоящий тикет, а не PR (у PR присутствует поле pull_request). */
function isRealTicket(raw: RawIssue): boolean {
  return raw.pull_request === undefined;
}

/**
 * Провайдер тикетов поверх GitHub Issues. Один сервер API обслуживает и github.com, и Enterprise
 * (base URL из конфига). `fetch` и пауза инжектируются (тестируемо; реальная пауза — из cli.ts).
 */
export function createGithubTicketProvider(
  config: SupportConfig,
  fetchFn: FetchLike,
  sleep: (ms: number) => Promise<void>,
): TicketProvider {
  const request = (method: string, path: string, body?: unknown): Promise<unknown> =>
    requestJson({
      fetchFn,
      method,
      url: `${config.apiBaseUrl}${path}`,
      headers: headers(config.token),
      ...(body === undefined ? {} : { body }),
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      retryBaseMs: config.retryBaseMs,
      sleep,
    });

  const repoPath = `/repos/${config.repo}`;

  /** Все записи постраничного GET (для длинных тредов комментариев; путь без query-строки). */
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

  return {
    async getTicket(id: number): Promise<Ticket> {
      return mapIssue((await request('GET', `${repoPath}/issues/${id}`)) as RawIssue);
    },

    async listTickets(limit: number): Promise<Ticket[]> {
      const raw = (await request(
        'GET',
        `${repoPath}/issues?state=open&per_page=${limit}`,
      )) as unknown;
      const issues = Array.isArray(raw) ? (raw as RawIssue[]) : [];
      return issues.filter(isRealTicket).map(mapIssue).slice(0, limit);
    },

    async searchTickets(query: string, limit: number): Promise<Ticket[]> {
      const q = encodeURIComponent(`repo:${config.repo} is:issue ${query}`);
      const result = (await request('GET', `/search/issues?q=${q}&per_page=${limit}`)) as {
        items?: unknown;
      };
      const items = Array.isArray(result.items) ? (result.items as RawIssue[]) : [];
      return items.map(mapIssue).slice(0, limit);
    },

    async getComments(id: number): Promise<TicketComment[]> {
      const raw = (await fetchAllPages(`${repoPath}/issues/${id}/comments`)) as RawComment[];
      return raw.map(mapComment);
    },

    async addComment(id: number, body: string): Promise<TicketComment> {
      return mapComment(
        (await request('POST', `${repoPath}/issues/${id}/comments`, { body })) as RawComment,
      );
    },
  };
}
