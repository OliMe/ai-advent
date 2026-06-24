import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseServerConfig, parseServers } from '../index.ts';

describe('parseServerConfig', () => {
  it('stdio: command/args/env, нестроки отброшены', () => {
    const config = parseServerConfig('s', {
      command: 'node',
      args: ['a', 1, 'b'],
      env: { K: 'v', N: 2 },
    });
    assert.deepEqual(config, {
      transport: 'stdio',
      command: 'node',
      args: ['a', 'b'],
      env: { K: 'v' },
    });
  });

  it('stdio без args/env', () => {
    assert.deepEqual(parseServerConfig('s', { command: 'node' }), {
      transport: 'stdio',
      command: 'node',
      args: [],
    });
  });

  it('http: url с заголовками и без', () => {
    assert.deepEqual(parseServerConfig('h', { url: 'http://x/mcp', headers: { A: 'b' } }), {
      transport: 'http',
      url: 'http://x/mcp',
      headers: { A: 'b' },
    });
    assert.deepEqual(parseServerConfig('h', { url: 'http://x/mcp' }), {
      transport: 'http',
      url: 'http://x/mcp',
    });
  });

  it('ошибки: не объект, массив, нет command и url', () => {
    assert.throws(() => parseServerConfig('s', 'строка'), /должна быть объектом/);
    assert.throws(() => parseServerConfig('s', []), /должна быть объектом/); // массив — не объект
    assert.throws(() => parseServerConfig('s', {}), /command.*url/);
  });
});

describe('parseServers', () => {
  it('разбирает карту mcpServers', () => {
    const servers = parseServers({
      mcpServers: { a: { command: 'node' }, b: { url: 'http://x/mcp' } },
    });
    assert.deepEqual([...servers.keys()], ['a', 'b']);
    assert.equal(servers.get('a')?.transport, 'stdio');
    assert.equal(servers.get('b')?.transport, 'http');
  });

  it('нет карты / null / не объект → пусто', () => {
    assert.equal(parseServers({}).size, 0);
    assert.equal(parseServers(null).size, 0);
    assert.equal(parseServers('строка').size, 0);
  });
});
