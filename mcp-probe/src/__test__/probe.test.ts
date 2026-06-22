import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { probeTools } from '../index.ts';
import type { ToolProbe } from '../index.ts';

describe('probeTools', () => {
  it('подключается, запрашивает инструменты и закрывает соединение', async () => {
    const calls: string[] = [];
    const probe: ToolProbe = {
      connect: async () => void calls.push('connect'),
      listTools: async () => {
        calls.push('list');
        return { tools: [{ name: 'tavily-search' }] };
      },
      close: async () => void calls.push('close'),
    };

    const tools = await probeTools(probe);

    assert.deepEqual(tools, { tools: [{ name: 'tavily-search' }] });
    assert.deepEqual(calls, ['connect', 'list', 'close']); // порядок и обязательное закрытие
  });

  it('закрывает соединение даже при ошибке запроса и пробрасывает ошибку', async () => {
    const calls: string[] = [];
    const probe: ToolProbe = {
      connect: async () => void calls.push('connect'),
      listTools: async () => {
        throw new Error('сбой');
      },
      close: async () => void calls.push('close'),
    };

    await assert.rejects(() => probeTools(probe), /сбой/);
    assert.deepEqual(calls, ['connect', 'close']); // close вызван в finally
  });
});
