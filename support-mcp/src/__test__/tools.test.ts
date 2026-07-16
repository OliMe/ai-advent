import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleGetTicket,
  handleListTickets,
  handleSearchTickets,
  handleGetTicketComments,
  handleAddTicketComment,
  SUPPORT_MARKER,
} from '../index.ts';
import type { ToolDeps, TicketProvider, Ticket, TicketComment } from '../index.ts';

const TICKET: Ticket = {
  id: 42,
  title: 'Не входит в аккаунт',
  body: 'После обновления не пускает',
  author: { login: 'user1' },
  labels: ['auth'],
  state: 'open',
  url: 'https://example/42',
};

const COMMENT: TicketComment = {
  id: 1,
  author: { login: 'user1' },
  body: 'Есть идеи?',
  createdAt: '2026-07-17T00:00:00Z',
  isBot: false,
};

/** Фейковый провайдер: записывает вызовы, отдаёт канонические данные. */
function fakeDeps(maxOutputChars = 8000): {
  deps: ToolDeps;
  calls: { name: string; args: unknown[] }[];
} {
  const calls: { name: string; args: unknown[] }[] = [];
  const provider: TicketProvider = {
    async getTicket(id) {
      calls.push({ name: 'getTicket', args: [id] });
      return TICKET;
    },
    async listTickets(limit) {
      calls.push({ name: 'listTickets', args: [limit] });
      return [TICKET];
    },
    async searchTickets(query, limit) {
      calls.push({ name: 'searchTickets', args: [query, limit] });
      return [TICKET];
    },
    async getComments(id) {
      calls.push({ name: 'getComments', args: [id] });
      return [COMMENT];
    },
    async addComment(id, body) {
      calls.push({ name: 'addComment', args: [id, body] });
      return { ...COMMENT, id: 99, body, isBot: true };
    },
  };
  return { deps: { provider, maxOutputChars }, calls };
}

describe('handleGetTicket', () => {
  it('валидный id → JSON тикета', async () => {
    const { deps, calls } = fakeDeps();
    const out = JSON.parse(await handleGetTicket(deps, { id: 42 }));
    assert.equal(out.title, 'Не входит в аккаунт');
    assert.deepEqual(calls[0], { name: 'getTicket', args: [42] });
  });

  it('нет id → JSON-ошибка', async () => {
    const { deps } = fakeDeps();
    assert.match(JSON.parse(await handleGetTicket(deps, {})).error, /id тикета/);
  });
});

describe('handleListTickets', () => {
  it('дефолтный limit 20', async () => {
    const { deps, calls } = fakeDeps();
    JSON.parse(await handleListTickets(deps, {}));
    assert.deepEqual(calls[0], { name: 'listTickets', args: [20] });
  });

  it('limit зажимается сверху и снизу', async () => {
    const { deps, calls } = fakeDeps();
    await handleListTickets(deps, { limit: 999 });
    await handleListTickets(deps, { limit: 0 });
    assert.equal(calls[0].args[0], 100);
    assert.equal(calls[1].args[0], 1);
  });
});

describe('handleSearchTickets', () => {
  it('query + limit → JSON-массив', async () => {
    const { deps, calls } = fakeDeps();
    const out = JSON.parse(await handleSearchTickets(deps, { query: 'авторизация', limit: 5 }));
    assert.equal(out.length, 1);
    assert.deepEqual(calls[0], { name: 'searchTickets', args: ['авторизация', 5] });
  });

  it('пустой query → JSON-ошибка', async () => {
    const { deps } = fakeDeps();
    assert.match(JSON.parse(await handleSearchTickets(deps, { query: '  ' })).error, /query/);
  });
});

describe('handleGetTicketComments', () => {
  it('валидный id → JSON комментариев', async () => {
    const { deps, calls } = fakeDeps();
    const out = JSON.parse(await handleGetTicketComments(deps, { id: 42 }));
    assert.equal(out[0].body, 'Есть идеи?');
    assert.deepEqual(calls[0], { name: 'getComments', args: [42] });
  });

  it('нет id → JSON-ошибка', async () => {
    const { deps } = fakeDeps();
    assert.match(JSON.parse(await handleGetTicketComments(deps, { id: 'abc' })).error, /id тикета/);
  });
});

describe('handleAddTicketComment', () => {
  it('id + body → тело помечается маркером, JSON созданного', async () => {
    const { deps, calls } = fakeDeps();
    const out = JSON.parse(await handleAddTicketComment(deps, { id: 42, body: 'Проверьте токен' }));
    assert.equal(out.id, 99);
    const postedBody = calls[0].args[1] as string;
    assert.ok(postedBody.includes('Проверьте токен'));
    assert.ok(postedBody.includes(SUPPORT_MARKER));
  });

  it('нет id → ошибка', async () => {
    const { deps } = fakeDeps();
    assert.match(JSON.parse(await handleAddTicketComment(deps, { body: 'x' })).error, /id тикета/);
  });

  it('нет body → ошибка', async () => {
    const { deps } = fakeDeps();
    assert.match(JSON.parse(await handleAddTicketComment(deps, { id: 42 })).error, /body/);
  });
});

describe('усечение вывода', () => {
  it('длинный JSON усекается с пометкой', async () => {
    const { deps } = fakeDeps(20);
    const out = await handleGetTicket(deps, { id: 42 });
    assert.match(out, /вывод усечён/);
  });
});
