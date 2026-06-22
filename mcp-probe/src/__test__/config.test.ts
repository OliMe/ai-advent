import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadMcpConfig,
  loadProbeAction,
  resolveProbeAction,
  parseArgs,
  parseHeaders,
} from '../index.ts';

const env = (values: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  values as NodeJS.ProcessEnv;

describe('parseArgs', () => {
  it('разбивает по пробелам и игнорирует пустые', () => {
    assert.deepEqual(parseArgs('-y tavily-mcp'), ['-y', 'tavily-mcp']);
    assert.deepEqual(parseArgs('  one   two  '), ['one', 'two']);
    assert.deepEqual(parseArgs(undefined), []);
    assert.deepEqual(parseArgs('   '), []); // только пробелы → пусто
  });
});

describe('parseHeaders', () => {
  it('разбирает пары «имя: значение» и добавляет Bearer', () => {
    const headers = parseHeaders(
      env({ MCP_HEADERS: 'X-Api-Key: abc; X-Org: acme', MCP_BEARER_TOKEN: 'tkn' }),
    );
    assert.equal(headers['X-Api-Key'], 'abc');
    assert.equal(headers['X-Org'], 'acme');
    assert.equal(headers.Authorization, 'Bearer tkn');
  });

  it('пропускает пары без двоеточия и без имени; без заголовков — пусто', () => {
    const headers = parseHeaders(env({ MCP_HEADERS: 'мусор; : значение; X-Ok: да' }));
    assert.deepEqual(headers, { 'X-Ok': 'да' });
    assert.deepEqual(parseHeaders(env({})), {});
  });
});

describe('loadMcpConfig', () => {
  it('stdio из MCP_COMMAND, аргументы и проброс окружения', () => {
    const config = loadMcpConfig(
      env({ MCP_COMMAND: 'npx', MCP_ARGS: '-y tavily-mcp', TAVILY_API_KEY: 'k', EMPTY: undefined }),
    );
    assert.equal(config.transport, 'stdio');
    if (config.transport !== 'stdio') return;
    assert.equal(config.command, 'npx');
    assert.deepEqual(config.args, ['-y', 'tavily-mcp']);
    assert.equal(config.env.TAVILY_API_KEY, 'k'); // ключ форвардится серверу
    assert.equal('EMPTY' in config.env, false); // undefined-значения отброшены
  });

  it('http из MCP_URL с заголовками', () => {
    const config = loadMcpConfig(
      env({ MCP_URL: 'http://localhost:3000/mcp', MCP_BEARER_TOKEN: 't' }),
    );
    assert.equal(config.transport, 'http');
    if (config.transport !== 'http') return;
    assert.equal(config.url, 'http://localhost:3000/mcp');
    assert.equal(config.headers.Authorization, 'Bearer t');
  });

  it('явный MCP_TRANSPORT имеет приоритет над выводом', () => {
    // Заданы оба источника, но транспорт явно http → берём http.
    const config = loadMcpConfig(
      env({ MCP_TRANSPORT: 'HTTP', MCP_URL: 'http://h/mcp', MCP_COMMAND: 'npx' }),
    );
    assert.equal(config.transport, 'http');
  });

  it('ошибки конфигурации', () => {
    assert.throws(() => loadMcpConfig(env({})), /MCP_COMMAND.*MCP_URL|MCP_COMMAND/);
    assert.throws(() => loadMcpConfig(env({ MCP_TRANSPORT: 'ftp' })), /Неизвестный MCP_TRANSPORT/);
    // Транспорт http задан явно, но URL не задан.
    assert.throws(() => loadMcpConfig(env({ MCP_TRANSPORT: 'http' })), /MCP_URL/);
    // Транспорт stdio задан явно, но команда не задана.
    assert.throws(() => loadMcpConfig(env({ MCP_TRANSPORT: 'stdio' })), /MCP_COMMAND/);
  });
});

describe('loadProbeAction', () => {
  it('без MCP_TOOL — действие пустое (список инструментов)', () => {
    assert.deepEqual(loadProbeAction(env({})), {});
    assert.deepEqual(loadProbeAction(env({ MCP_TOOL: '   ' })), {}); // пустое имя
  });

  it('с MCP_TOOL — вызов инструмента, аргументы по умолчанию пустые', () => {
    assert.deepEqual(loadProbeAction(env({ MCP_TOOL: 'tavily-search' })), {
      tool: { name: 'tavily-search', arguments: {} },
    });
  });

  it('разбирает MCP_TOOL_ARGS как JSON-объект', () => {
    const action = loadProbeAction(env({ MCP_TOOL: 'search', MCP_TOOL_ARGS: '{"query":"mcp"}' }));
    assert.deepEqual(action.tool?.arguments, { query: 'mcp' });
  });

  it('отвергает невалидный или не-объектный MCP_TOOL_ARGS', () => {
    assert.throws(() => loadProbeAction(env({ MCP_TOOL: 's', MCP_TOOL_ARGS: '{плохо' })), /JSON/);
    assert.throws(
      () => loadProbeAction(env({ MCP_TOOL: 's', MCP_TOOL_ARGS: '[1,2]' })),
      /JSON-объект/,
    );
  });
});

describe('resolveProbeAction', () => {
  it('имя инструмента из CLI + JSON-аргументы вторым позиционным', () => {
    assert.deepEqual(resolveProbeAction(['tavily-search', '{"query":"mcp"}'], env({})), {
      tool: { name: 'tavily-search', arguments: { query: 'mcp' } },
    });
  });

  it('CLI без аргументов инструмента → пустые arguments', () => {
    assert.deepEqual(resolveProbeAction(['list-something'], env({})), {
      tool: { name: 'list-something', arguments: {} },
    });
  });

  it('CLI важнее окружения (MCP_TOOL игнорируется)', () => {
    const action = resolveProbeAction(['from-cli'], env({ MCP_TOOL: 'from-env' }));
    assert.equal(action.tool?.name, 'from-cli');
  });

  it('нет аргумента CLI → откат к окружению (MCP_TOOL)', () => {
    assert.deepEqual(resolveProbeAction([], env({ MCP_TOOL: 'from-env' })), {
      tool: { name: 'from-env', arguments: {} },
    });
  });

  it('нет ни CLI, ни MCP_TOOL → список инструментов (пустое действие)', () => {
    assert.deepEqual(resolveProbeAction([], env({})), {});
    assert.deepEqual(resolveProbeAction(['   '], env({})), {}); // пробельное имя — не инструмент
  });
});
