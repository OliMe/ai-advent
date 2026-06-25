import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findPollTool, pollNewResults } from '../index.ts';
import type { ToolSet } from '../index.ts';

/** Фейковый набор: задаём имя инструмента (или нет) и реализацию call. */
function toolSet(
  name: string | null,
  call: (n: string, a: Record<string, unknown>) => Promise<string>,
): ToolSet {
  return {
    specs: () => (name === null ? [] : [{ name, description: '', parameters: {} }]),
    call,
  };
}

describe('findPollTool', () => {
  it('находит инструмент по суффиксу или возвращает null', () => {
    assert.equal(
      findPollTool(toolSet('sched__poll_results', async () => '')),
      'sched__poll_results',
    );
    assert.equal(findPollTool(toolSet('sched__echo', async () => '')), null);
    assert.equal(findPollTool(toolSet(null, async () => '')), null);
  });
});

describe('pollNewResults', () => {
  it('передаёт since и возвращает новые запуски + курсор (последний firedAt)', async () => {
    let receivedSince: unknown = null;
    const set = toolSet('s__poll_results', async (_n, args) => {
      receivedSince = args.since;
      return JSON.stringify({
        runs: [
          { firedAt: 't1', taskTitle: 'A', ok: true, text: 'a' },
          { firedAt: 't2', taskTitle: 'B', ok: false, text: 'b' },
        ],
      });
    });
    const result = await pollNewResults(set, 'cursor0');
    assert.equal(receivedSince, 'cursor0');
    assert.equal(result.runs.length, 2);
    assert.equal(result.cursor, 't2');
  });

  it('нет инструмента poll_results → пусто, курсор без изменений', async () => {
    const result = await pollNewResults(
      toolSet('s__echo', async () => ''),
      'X',
    );
    assert.deepEqual(result, { runs: [], cursor: 'X' });
  });

  it('пустой список → курсор без изменений', async () => {
    const result = await pollNewResults(
      toolSet('s__poll_results', async () => JSON.stringify({ runs: [] })),
      'X',
    );
    assert.deepEqual(result, { runs: [], cursor: 'X' });
  });

  it('битый JSON → пусто', async () => {
    const result = await pollNewResults(
      toolSet('s__poll_results', async () => 'не json'),
      'X',
    );
    assert.deepEqual(result, { runs: [], cursor: 'X' });
  });

  it('runs не массив → пусто', async () => {
    const result = await pollNewResults(
      toolSet('s__poll_results', async () => JSON.stringify({ runs: 5 })),
      'X',
    );
    assert.deepEqual(result.runs, []);
  });

  it('некорректные элементы отфильтровываются', async () => {
    const set = toolSet('s__poll_results', async () =>
      JSON.stringify({ runs: ['мусор', { firedAt: 't1', taskTitle: 'A', ok: true, text: 'a' }] }),
    );
    const result = await pollNewResults(set, 'X');
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].taskTitle, 'A');
  });
});
