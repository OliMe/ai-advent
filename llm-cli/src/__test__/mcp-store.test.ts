import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMcpStore } from '../index.ts';
import type { McpServerConfig } from '../../../mcp-client/src/index.ts';

describe('FileMcpStore', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-store-'));
    path = join(dir, 'sub', 'mcp.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('сохраняет и загружает stdio и http (создаёт каталог)', () => {
    const store = new FileMcpStore(path);
    const servers = new Map<string, McpServerConfig>([
      ['a', { transport: 'stdio', command: 'node', args: ['x'], env: { K: 'v' } }],
      ['b', { transport: 'http', url: 'http://h/mcp', headers: { A: 'b' } }],
    ]);
    store.save(servers);

    const loaded = new FileMcpStore(path).load();
    assert.deepEqual(loaded.get('a'), {
      transport: 'stdio',
      command: 'node',
      args: ['x'],
      env: { K: 'v' },
    });
    assert.deepEqual(loaded.get('b'), {
      transport: 'http',
      url: 'http://h/mcp',
      headers: { A: 'b' },
    });
  });

  it('round-trip stdio без env и http без headers', () => {
    const store = new FileMcpStore(path);
    store.save(
      new Map<string, McpServerConfig>([
        ['s', { transport: 'stdio', command: 'node', args: [] }],
        ['h', { transport: 'http', url: 'http://h/mcp' }],
      ]),
    );
    const loaded = store.load();
    assert.deepEqual(loaded.get('s'), { transport: 'stdio', command: 'node', args: [] });
    assert.deepEqual(loaded.get('h'), { transport: 'http', url: 'http://h/mcp' });
  });

  it('нет файла → пустая карта', () => {
    assert.equal(new FileMcpStore(join(dir, 'нет.json')).load().size, 0);
  });

  it('битый JSON → пустая карта', () => {
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{не json');
    assert.equal(new FileMcpStore(broken).load().size, 0);
  });
});
