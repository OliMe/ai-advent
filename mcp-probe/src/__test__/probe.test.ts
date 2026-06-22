import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runProbe } from '../index.ts';
import type { McpProbe } from '../index.ts';

/** Заглушка клиента: журналирует вызовы; listTools/callTool отдают помеченный результат. */
function fakeProbe(calls: string[], overrides: Partial<McpProbe> = {}): McpProbe {
  return {
    connect: async () => void calls.push('connect'),
    listTools: async () => {
      calls.push('list');
      return { tools: [{ name: 'search' }] };
    },
    callTool: async (name, args) => {
      calls.push(`call:${name}`);
      return { name, args };
    },
    close: async () => void calls.push('close'),
    ...overrides,
  };
}

describe('runProbe', () => {
  it('без действия — список инструментов, затем закрытие', async () => {
    const calls: string[] = [];
    const result = await runProbe(fakeProbe(calls), {});
    assert.deepEqual(result, { tools: [{ name: 'search' }] });
    assert.deepEqual(calls, ['connect', 'list', 'close']);
  });

  it('с действием — вызов инструмента с аргументами, затем закрытие', async () => {
    const calls: string[] = [];
    const result = await runProbe(fakeProbe(calls), {
      tool: { name: 'search', arguments: { query: 'mcp' } },
    });
    assert.deepEqual(result, { name: 'search', args: { query: 'mcp' } });
    assert.deepEqual(calls, ['connect', 'call:search', 'close']);
  });

  it('закрывает соединение даже при ошибке запроса и пробрасывает её', async () => {
    const calls: string[] = [];
    const probe = fakeProbe(calls, {
      listTools: async () => {
        throw new Error('сбой');
      },
    });
    await assert.rejects(() => runProbe(probe, {}), /сбой/);
    assert.deepEqual(calls, ['connect', 'close']); // close вызван в finally
  });
});
