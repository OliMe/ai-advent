import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { driveInteractive, fakeStore, clientWith } from './helpers.ts';
import { McpToolSet } from '../../../mcp-client/src/index.ts';
import type { ConnectFn, McpServerConfig } from '../../../mcp-client/src/index.ts';
import type { McpStore } from '../index.ts';
import { makeConfig } from '../../../core/src/__test__/helpers.ts';

const PLAN = JSON.stringify({ steps: ['шаг'], criteria: ['критерий'], text: 'план' });
const EXEC = JSON.stringify({ summary: 'готово', log: [], text: 'результат' });
const PASS = JSON.stringify({ passed: true, issues: [], text: 'ок' });
const DONE = JSON.stringify({ summary: 'итог', text: 'резюме' });
const STDIO: McpServerConfig = { transport: 'stdio', command: 'x', args: [] };

/** Хранилище конфигурации MCP в памяти (для тестов). */
function memoryStore(initial: Map<string, McpServerConfig> = new Map()): McpStore {
  let servers = new Map(initial);
  return {
    load: () => new Map(servers),
    save: updated => {
      servers = new Map(updated);
    },
  };
}

/** Фабрика подключения: каждый сервер даёт инструмент echo. */
const fakeConnect: ConnectFn = async name => ({
  name,
  tools: () => [{ name: 'echo', description: 'эхо', parameters: { type: 'object' } }],
  call: async (tool, args) => `${name}/${tool}: ${JSON.stringify(args)}`,
  close: async () => {},
});

describe('интерактив — команды /mcp', () => {
  it('при выключенном MCP все команды /mcp сообщают об этом', async t => {
    const client = clientWith(t, async () => ({ content: 'x', usage: undefined }));
    const { finished, text } = driveInteractive(client, [
      '/mcp',
      '/mcp add x y',
      '/mcp remove x',
      '/mcp reload',
      '/exit',
    ]);
    await finished;
    assert.equal((text().match(/MCP выключен/g) ?? []).length, 4);
  });

  it('add подключает и сохраняет, list показывает, remove удаляет', async t => {
    const client = clientWith(t, async () => ({ content: 'x', usage: undefined }));
    const store = memoryStore();
    const mcp = { toolSet: new McpToolSet(fakeConnect), store };
    const { finished, text } = driveInteractive(
      client,
      ['/mcp', '/mcp add srv npx demo', '/mcp', '/mcp remove srv', '/mcp remove нет', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
      undefined,
      'window',
      6,
      undefined,
      mcp,
    );
    await finished;
    const out = text();
    assert.match(out, /MCP-серверы не подключены/); // первый /mcp
    assert.match(out, /MCP «srv» подключён и сохранён/); // add
    assert.match(out, /• srv: echo/); // list с инструментом
    assert.match(out, /MCP «srv» отключён и удалён/); // remove
    assert.match(out, /MCP-сервер не найден: нет/); // remove несуществующего
    assert.equal(store.load().has('srv'), false); // стор обновлён
  });

  it('add без спецификации сервера — ошибка', async t => {
    const client = clientWith(t, async () => ({ content: 'x', usage: undefined }));
    const mcp = { toolSet: new McpToolSet(fakeConnect), store: memoryStore() };
    const { finished, text } = driveInteractive(
      client,
      ['/mcp add srv', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
      undefined,
      'window',
      6,
      undefined,
      mcp,
    );
    await finished;
    assert.match(text(), /Не удалось добавить MCP-сервер/);
  });

  it('подключение на старте и reload; сбой одного сервера не валит остальные', async t => {
    const client = clientWith(t, async () => ({ content: 'x', usage: undefined }));
    const store = memoryStore(
      new Map([
        ['ok', STDIO],
        ['bad', STDIO],
      ]),
    );
    const connect: ConnectFn = async name => {
      if (name === 'bad') {
        throw new Error('нет сервера');
      }
      return {
        name,
        tools: () => [{ name: 't', description: '', parameters: {} }],
        call: async () => '',
        close: async () => {},
      };
    };
    const mcp = { toolSet: new McpToolSet(connect), store };
    const { finished, text } = driveInteractive(
      client,
      ['/mcp reload', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
      undefined,
      'window',
      6,
      undefined,
      mcp,
    );
    await finished;
    const out = text();
    assert.match(out, /🔌 MCP «ok» подключён/); // успешное подключение на старте
    assert.match(out, /⚠ MCP «bad» не подключён/); // сбой не уронил
    assert.ok((out.match(/🔌 MCP «ok» подключён/g) ?? []).length >= 2); // ещё раз при reload
  });

  it('агент в прогоне вызывает MCP-инструмент (печатается)', async t => {
    let plannerCalls = 0;
    const client = clientWith(t, async messages => {
      const persona = messages[0]?.content ?? '';
      if (persona.includes('аналитик')) {
        return { content: '{"done":true}', usage: undefined };
      }
      if (persona.includes('планировщик')) {
        plannerCalls++;
        return plannerCalls === 1
          ? {
              content: '',
              toolCalls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'srv__echo', arguments: '{"q":"hi"}' },
                },
              ],
              usage: undefined,
            }
          : { content: PLAN, usage: undefined };
      }
      if (persona.includes('исполнитель')) {
        return { content: EXEC, usage: undefined };
      }
      if (persona.includes('проверяющий')) {
        return { content: PASS, usage: undefined };
      }
      return { content: DONE, usage: undefined };
    });
    const mcp = {
      toolSet: new McpToolSet(fakeConnect),
      store: memoryStore(new Map([['srv', STDIO]])),
    };
    const { finished, text } = driveInteractive(
      client,
      ['/run сделай задачу', 'да', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
      undefined,
      'window',
      6,
      undefined,
      mcp,
    );
    await finished;
    const out = text();
    assert.match(out, /🔧 инструмент srv__echo/); // вызов инструмента агентом напечатан
    assert.match(out, /завершена и подтверждена/); // прогон дошёл до конца
  });
});
