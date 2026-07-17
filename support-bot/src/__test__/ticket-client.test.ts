import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTicketThread, postReply } from '../index.ts';
import type { ToolSet } from '../../../core/src/index.ts';

/** Фейковый ToolSet с неймспейсными именами инструментов. */
function fakeToolSet(
  handlers: Record<string, (args: Record<string, unknown>) => string>,
  names?: string[],
): { toolSet: ToolSet; calls: { name: string; args: Record<string, unknown> }[] } {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const toolNames = names ?? Object.keys(handlers);
  const toolSet: ToolSet = {
    specs: () => toolNames.map(name => ({ name, description: '', parameters: {} })),
    call: async (name, args) => {
      calls.push({ name, args });
      return handlers[name](args);
    },
  };
  return { toolSet, calls };
}

const TICKET_JSON = JSON.stringify({
  id: 7,
  title: 'Не входит',
  body: 'описание',
  author: { login: 'u' },
  labels: ['auth'],
  state: 'open',
  url: 'x',
});

describe('readTicketThread', () => {
  it('читает тикет и тред (неймспейсные инструменты по суффиксу)', async () => {
    const { toolSet, calls } = fakeToolSet({
      support__get_ticket: () => TICKET_JSON,
      support__get_ticket_comments: () =>
        JSON.stringify([
          { id: 1, author: { login: 'u' }, body: 'вопрос', createdAt: 't', isBot: false },
        ]),
    });
    const { ticket, comments } = await readTicketThread(toolSet, 7);
    assert.equal(ticket.id, 7);
    assert.equal(comments.length, 1);
    assert.deepEqual(calls[0], { name: 'support__get_ticket', args: { id: 7 } });
  });

  it('комментарии не массив → пустой тред', async () => {
    const { toolSet } = fakeToolSet({
      support__get_ticket: () => TICKET_JSON,
      support__get_ticket_comments: () => JSON.stringify({ message: 'oops' }),
    });
    assert.deepEqual((await readTicketThread(toolSet, 7)).comments, []);
  });

  it('инструмент не подключён → ошибка', async () => {
    const { toolSet } = fakeToolSet({}, []);
    await assert.rejects(readTicketThread(toolSet, 7), /get_ticket не найден/);
  });

  it('битый JSON → ошибка разбора', async () => {
    const { toolSet } = fakeToolSet({ support__get_ticket: () => 'не json' });
    await assert.rejects(readTicketThread(toolSet, 7), /разобрать JSON/);
  });

  it('инструмент вернул {error} → ошибка', async () => {
    const { toolSet } = fakeToolSet({
      support__get_ticket: () => JSON.stringify({ error: 'нужен id' }),
    });
    await assert.rejects(readTicketThread(toolSet, 7), /вернул ошибку/);
  });
});

describe('postReply', () => {
  it('постит через add_ticket_comment с id и body', async () => {
    const { toolSet, calls } = fakeToolSet({
      support__add_ticket_comment: () =>
        JSON.stringify({
          id: 99,
          author: { login: 'bot' },
          body: 'x',
          createdAt: 't',
          isBot: true,
        }),
    });
    await postReply(toolSet, 7, 'ответ');
    assert.deepEqual(calls[0], {
      name: 'support__add_ticket_comment',
      args: { id: 7, body: 'ответ' },
    });
  });

  it('ошибка постинга пробрасывается', async () => {
    const { toolSet } = fakeToolSet({
      support__add_ticket_comment: () => JSON.stringify({ error: 'нет прав' }),
    });
    await assert.rejects(postReply(toolSet, 7, 'ответ'), /вернул ошибку/);
  });
});
