import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findGitServerName,
  allowRepositoryInGitServer,
  revokeRepositoryInGitServer,
} from '../index.ts';
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

describe('revokeRepositoryInGitServer', () => {
  it('убирает репозиторий из GIT_ALLOWED_REPOS, остальные сохраняет', () => {
    const store = memoryStore({
      git: {
        transport: 'stdio',
        command: 'node',
        args: ['/cli.ts'],
        env: { GIT_ALLOWED_REPOS: '/work/api,/work/web' },
      },
    });

    const result = revokeRepositoryInGitServer(store, 'git', '/work/api');

    assert.equal(result.kind, 'removed');
    const config = store.load().get('git');
    assert.equal(config?.transport === 'stdio' ? config.env?.GIT_ALLOWED_REPOS : '', '/work/web');
  });

  it('последний репозиторий убран — ключ GIT_ALLOWED_REPOS удаляется целиком', () => {
    const store = memoryStore({
      git: {
        transport: 'stdio',
        command: 'node',
        args: ['/cli.ts'],
        env: { GIT_ALLOWED_REPOS: '/work/api' },
      },
    });

    revokeRepositoryInGitServer(store, 'git', '/work/api');

    const config = store.load().get('git');
    // Список опустел — env целиком убран, а не оставлен пустой строкой.
    assert.deepEqual(config, { transport: 'stdio', command: 'node', args: ['/cli.ts'] });
  });

  it('прочие переменные окружения при опустевшем списке сохраняются', () => {
    const store = memoryStore({
      git: {
        transport: 'stdio',
        command: 'node',
        args: ['/cli.ts'],
        env: { GIT_ALLOWED_REPOS: '/work/api', GIT_MAX_OUTPUT_CHARS: '5000' },
      },
    });

    revokeRepositoryInGitServer(store, 'git', '/work/api');

    const config = store.load().get('git');
    assert.deepEqual(config?.transport === 'stdio' ? config.env : {}, {
      GIT_MAX_OUTPUT_CHARS: '5000',
    });
  });

  it('репозитория нет в нашем списке (ручной аргумент/рабочий каталог) — не наша запись, absent', () => {
    const store = memoryStore({
      git: { transport: 'stdio', command: 'node', args: ['/cli.ts', '/work/manual'] },
    });

    // Прописанное вручную (в args) клиент не убирает — только свою env-часть.
    assert.deepEqual(revokeRepositoryInGitServer(store, 'git', '/work/manual'), { kind: 'absent' });
  });

  it('сервера нет или он по HTTP — allow-list не наш', () => {
    assert.equal(revokeRepositoryInGitServer(memoryStore({}), 'git', '/x').kind, 'unavailable');
    const http = memoryStore({ git: { transport: 'http', url: 'https://example.com/mcp' } });
    assert.equal(revokeRepositoryInGitServer(http, 'git', '/x').kind, 'unavailable');
  });
});
