import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGithubTicketProvider, createProvider } from '../index.ts';
import type { SupportConfig } from '../index.ts';
import type { FetchLike, HttpResponse } from '../../../core/src/index.ts';

const CONFIG: SupportConfig = {
  provider: 'github',
  apiBaseUrl: 'https://api.test',
  repo: 'o/r',
  token: 'tok',
  maxOutputChars: 8000,
  timeoutMs: 1000,
  maxRetries: 0,
  retryBaseMs: 1,
};

const noSleep = async () => {};

/** Успешный ответ-заглушка. */
function ok(body: unknown): HttpResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Провайдер поверх заданного fetch. */
function provider(fetchFn: FetchLike) {
  return createGithubTicketProvider(CONFIG, fetchFn, noSleep);
}

describe('getTicket', () => {
  it('маппит issue со всеми полями (имя автора, метки)', async () => {
    let seenUrl = '';
    const fetchFn: FetchLike = async url => {
      seenUrl = url;
      return ok({
        number: 42,
        title: 'Не входит',
        body: 'описание',
        user: { login: 'user1', name: 'Иван' },
        labels: [{ name: 'auth' }, { name: 'billing' }],
        state: 'open',
        html_url: 'https://x/42',
      });
    };
    const ticket = await provider(fetchFn).getTicket(42);
    assert.equal(seenUrl, 'https://api.test/repos/o/r/issues/42');
    assert.deepEqual(ticket, {
      id: 42,
      title: 'Не входит',
      body: 'описание',
      author: { login: 'user1', displayName: 'Иван' },
      labels: ['auth', 'billing'],
      state: 'open',
      url: 'https://x/42',
    });
  });

  it('пустой issue → безопасные дефолты (login unknown, пустые поля, метки [])', async () => {
    const ticket = await provider(async () => ok({ labels: 'не массив' })).getTicket(1);
    assert.deepEqual(ticket, {
      id: 0,
      title: '',
      body: '',
      author: { login: 'unknown' },
      labels: [],
      state: '',
      url: '',
    });
  });

  it('пустые login/name → login unknown, имя опускается', async () => {
    const ticket = await provider(async () =>
      ok({ number: 5, user: { login: '', name: '' } }),
    ).getTicket(5);
    assert.deepEqual(ticket.author, { login: 'unknown' });
  });

  it('метка без строкового name отфильтровывается', async () => {
    const ticket = await provider(async () =>
      ok({ number: 2, labels: [{ name: 'ok' }, { name: 123 }, {}] }),
    ).getTicket(2);
    assert.deepEqual(ticket.labels, ['ok']);
  });
});

describe('listTickets', () => {
  it('отсеивает PR (у него есть pull_request), режет по limit', async () => {
    let seenUrl = '';
    const fetchFn: FetchLike = async url => {
      seenUrl = url;
      return ok([
        { number: 1, title: 'тикет' },
        { number: 2, title: 'это PR', pull_request: { url: 'x' } },
        { number: 3, title: 'ещё тикет' },
      ]);
    };
    const tickets = await provider(fetchFn).listTickets(20);
    assert.equal(seenUrl, 'https://api.test/repos/o/r/issues?state=open&per_page=20');
    assert.deepEqual(
      tickets.map(t => t.id),
      [1, 3],
    );
  });

  it('не массив в ответе → пустой список', async () => {
    const tickets = await provider(async () => ok({ message: 'oops' })).listTickets(5);
    assert.deepEqual(tickets, []);
  });
});

describe('searchTickets', () => {
  it('строит /search/issues c query репозитория, маппит items', async () => {
    let seenUrl = '';
    const fetchFn: FetchLike = async url => {
      seenUrl = url;
      return ok({ items: [{ number: 7, title: 'найдено' }] });
    };
    const tickets = await provider(fetchFn).searchTickets('авторизация', 5);
    assert.ok(seenUrl.startsWith('https://api.test/search/issues?q='));
    assert.ok(seenUrl.includes(encodeURIComponent('repo:o/r is:issue авторизация')));
    assert.deepEqual(
      tickets.map(t => t.id),
      [7],
    );
  });

  it('items не массив → пустой список', async () => {
    const tickets = await provider(async () => ok({})).searchTickets('x', 5);
    assert.deepEqual(tickets, []);
  });
});

describe('getComments', () => {
  it('одна страница: маппит, isBot по маркеру, дефолты для пустого', async () => {
    const fetchFn: FetchLike = async () =>
      ok([
        { id: 1, user: { login: 'u' }, body: 'вопрос', created_at: 't1' },
        { id: 2, user: { login: 'bot' }, body: 'ответ\n\n<!-- ai-support -->', created_at: 't2' },
        {},
      ]);
    const comments = await provider(fetchFn).getComments(42);
    assert.equal(comments.length, 3);
    assert.equal(comments[0].isBot, false);
    assert.equal(comments[1].isBot, true);
    assert.deepEqual(comments[2], {
      id: 0,
      author: { login: 'unknown' },
      body: '',
      createdAt: '',
      isBot: false,
    });
  });

  it('пагинация: полная первая страница → берётся вторая', async () => {
    const page1 = Array.from({ length: 100 }, (_unused, index) => ({
      id: index + 1,
      user: { login: 'u' },
      body: `c${index}`,
      created_at: 't',
    }));
    const fetchFn: FetchLike = async url =>
      ok(url.includes('&page=1') ? page1 : [{ id: 999, user: { login: 'u' }, body: 'last' }]);
    const comments = await provider(fetchFn).getComments(42);
    assert.equal(comments.length, 101);
    assert.equal(comments[100].id, 999);
  });

  it('не массив на первой странице → пустой тред', async () => {
    const comments = await provider(async () => ok({ message: 'no' })).getComments(42);
    assert.deepEqual(comments, []);
  });

  it('пустой массив → пустой тред', async () => {
    const comments = await provider(async () => ok([])).getComments(42);
    assert.deepEqual(comments, []);
  });

  it('потолок страниц: каждая страница полная → обход останавливается на MAX_PAGES', async () => {
    const fullPage = Array.from({ length: 100 }, (_unused, index) => ({
      id: index,
      user: { login: 'u' },
      body: 'c',
      created_at: 't',
    }));
    const comments = await provider(async () => ok(fullPage)).getComments(42);
    assert.equal(comments.length, 100 * 20); // 20 страниц по 100 — упёрлись в потолок
  });
});

describe('addComment', () => {
  it('POST в тред, возвращает созданный комментарий', async () => {
    let seen: { url: string; method: string; body?: string } = { url: '', method: '' };
    const fetchFn: FetchLike = async (url, init) => {
      seen = { url, method: init.method, body: init.body };
      return ok({ id: 555, user: { login: 'bot' }, body: 'посланное', created_at: 't' });
    };
    const created = await provider(fetchFn).addComment(42, 'текст ответа');
    assert.equal(seen.url, 'https://api.test/repos/o/r/issues/42/comments');
    assert.equal(seen.method, 'POST');
    assert.equal(JSON.parse(seen.body as string).body, 'текст ответа');
    assert.equal(created.id, 555);
  });
});

describe('createProvider (шов)', () => {
  it('отдаёт рабочий провайдер (github)', async () => {
    const p = createProvider(CONFIG, async () => ok({ number: 3, title: 't' }), noSleep);
    assert.equal((await p.getTicket(3)).id, 3);
  });
});
