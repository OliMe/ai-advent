import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpToolSet } from '../index.ts';
import type { ConnectFn, McpConnection } from '../index.ts';
import type { McpServerConfig } from '../index.ts';

const stdio: McpServerConfig = { transport: 'stdio', command: 'x', args: [] };

describe('McpToolSet', () => {
  it('добавляет сервер, неймспейсит инструменты, маршрутизирует вызовы, отключает', async () => {
    const closed: string[] = [];
    const connect: ConnectFn = async name => ({
      name,
      tools: () => [{ name: 'search', description: 'd', parameters: {} }],
      call: async (tool, args) => `${name}:${tool}:${JSON.stringify(args)}`,
      close: async () => void closed.push(name),
    });
    const set = new McpToolSet(connect);

    assert.equal(await set.addServer('srv', stdio), 1); // число инструментов
    assert.deepEqual(set.serverNames(), ['srv']);
    assert.deepEqual(
      set.specs().map(spec => spec.name),
      ['srv__search'], // неймспейс «сервер__инструмент»
    );
    assert.equal(await set.call('srv__search', { q: 1 }), 'srv:search:{"q":1}');
    assert.equal(await set.removeServer('srv'), true);
    assert.deepEqual(closed, ['srv']);
    assert.deepEqual(set.serverNames(), []);
  });

  it('переподключение закрывает прежнее; remove несуществующего → false', async () => {
    const closed: string[] = [];
    const connect: ConnectFn = async name => ({
      name,
      tools: () => [],
      call: async () => '',
      close: async () => void closed.push(name),
    });
    const set = new McpToolSet(connect);

    await set.addServer('s', stdio);
    await set.addServer('s', stdio); // переподключение того же имени
    assert.equal(closed.length, 1); // прежнее соединение закрыто
    assert.equal(await set.removeServer('нет'), false);
  });

  it('ошибки вызова: без неймспейса и неподключённый сервер', async () => {
    const make = (name: string): McpConnection => ({
      name,
      tools: () => [],
      call: async () => '',
      close: async () => {},
    });
    const set = new McpToolSet(async name => make(name));

    await assert.rejects(() => set.call('без-сепаратора', {}), /без неймспейса/);
    await assert.rejects(() => set.call('нет__t', {}), /не подключён/);
  });

  it('close закрывает все соединения', async () => {
    const closed: string[] = [];
    const set = new McpToolSet(async name => ({
      name,
      tools: () => [],
      call: async () => '',
      close: async () => void closed.push(name),
    }));

    await set.addServer('a', stdio);
    await set.addServer('b', stdio);
    await set.close();

    assert.deepEqual(closed.sort(), ['a', 'b']);
    assert.deepEqual(set.serverNames(), []);
  });
});
