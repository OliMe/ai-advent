import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findGitServerName, allowRepositoryInGitServer } from '../index.ts';
import type { McpStore } from '../index.ts';
import type { McpServerConfig } from '../../../mcp-client/src/index.ts';

/** Хранилище конфигурации MCP в памяти. */
function memoryStore(initial: Record<string, McpServerConfig>): McpStore {
  let servers = new Map(Object.entries(initial));
  return { load: () => new Map(servers), save: updated => (servers = new Map(updated)) };
}

describe('findGitServerName', () => {
  it('опознаёт сервер по его инструменту, а не по имени «git»', () => {
    assert.equal(findGitServerName(['repo__git_branch', 'rag__search_docs']), 'repo');
  });

  it('git-сервера нет — null', () => {
    assert.equal(findGitServerName(['rag__search_docs']), null);
    // Инструмент без неймспейса сервера (набор собран не из MCP) — сервера тоже нет.
    assert.equal(findGitServerName(['git_branch']), null);
  });
});

describe('allowRepositoryInGitServer', () => {
  it('пишет репозиторий в GIT_ALLOWED_REPOS, не трогая аргументы (там путь к cli.ts и ручные настройки)', () => {
    const store = memoryStore({
      git: { transport: 'stdio', command: 'node', args: ['/cli.ts', '/work/manual'] },
    });

    const result = allowRepositoryInGitServer(store, 'git', '/work/api');

    assert.equal(result.kind, 'added');
    assert.deepEqual(store.load().get('git'), {
      transport: 'stdio',
      command: 'node',
      args: ['/cli.ts', '/work/manual'],
      env: { GIT_ALLOWED_REPOS: '/work/api' },
    });
  });

  it('второй проект дописывается к прежним, а не заменяет их', () => {
    const store = memoryStore({
      git: {
        transport: 'stdio',
        command: 'node',
        args: ['/cli.ts'],
        env: { GIT_ALLOWED_REPOS: '/work/api' },
      },
    });

    allowRepositoryInGitServer(store, 'git', '/work/web');

    const config = store.load().get('git');
    assert.equal(
      config?.transport === 'stdio' ? config.env?.GIT_ALLOWED_REPOS : '',
      '/work/api,/work/web',
    );
  });

  it('репозиторий уже разрешён — конфигурация не трогается', () => {
    const store = memoryStore({
      git: {
        transport: 'stdio',
        command: 'node',
        args: ['/cli.ts'],
        env: { GIT_ALLOWED_REPOS: '/work/api' },
      },
    });

    assert.deepEqual(allowRepositoryInGitServer(store, 'git', '/work/api'), { kind: 'already' });
  });

  it('сервера нет в конфигурации или он по HTTP — честно сообщаем, что allow-list не наш', () => {
    const empty = memoryStore({});
    assert.equal(allowRepositoryInGitServer(empty, 'git', '/work/api').kind, 'unavailable');

    const http = memoryStore({ git: { transport: 'http', url: 'https://example.com/mcp' } });
    const remote = allowRepositoryInGitServer(http, 'git', '/work/api');
    assert.equal(remote.kind, 'unavailable');
    assert.match(remote.kind === 'unavailable' ? remote.reason : '', /HTTP/);
  });
});
