import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { runWatch } from '../index.ts';
import type { ToolSet } from '../index.ts';

/** Приёмник вывода. */
function collector(): { stream: Writable; text: () => string } {
  let buffer = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        buffer += chunk.toString();
        callback();
      },
    }),
    text: () => buffer,
  };
}

/** Набор с poll_results: первый вызов (базовый) и последующие задаются ответами по очереди. */
function pollToolSet(responses: string[]): ToolSet {
  let index = 0;
  return {
    specs: () => [{ name: 's__poll_results', description: '', parameters: {} }],
    call: async () => responses[Math.min(index++, responses.length - 1)],
  };
}

describe('runWatch', () => {
  it('базовый курсор без шума, затем уведомляет о новом запуске', async () => {
    const output = collector();
    const notified: { title: string; message: string }[] = [];
    const toolSet = pollToolSet([
      JSON.stringify({ runs: [{ firedAt: 't0', taskTitle: 'base', ok: true, text: 'old' }] }), // базовый — игнор
      JSON.stringify({ runs: [{ firedAt: 't1', taskTitle: 'Погода', ok: true, text: 'тепло' }] }), // новый
    ]);
    let iterations = 0;
    await runWatch({
      toolSet,
      output: output.stream,
      notify: (title, message) => notified.push({ title, message }),
      sleep: async () => {},
      intervalMs: 1,
      shouldContinue: () => iterations++ < 1,
    });
    assert.match(output.text(), /🔔 ✓ Погода: тепло/);
    assert.deepEqual(notified, [{ title: 'Планировщик: Погода', message: 'тепло' }]);
  });

  it('неуспешный запуск помечается ✗', async () => {
    const output = collector();
    const toolSet = pollToolSet([
      JSON.stringify({ runs: [] }),
      JSON.stringify({
        runs: [{ firedAt: 't1', taskTitle: 'OCR', ok: false, text: 'недоступен' }],
      }),
    ]);
    let iterations = 0;
    await runWatch({
      toolSet,
      output: output.stream,
      notify: () => {},
      sleep: async () => {},
      intervalMs: 1,
      shouldContinue: () => iterations++ < 1,
    });
    assert.match(output.text(), /🔔 ✗ OCR: недоступен/);
  });

  it('shouldContinue=false сразу → только базовый опрос, без уведомлений', async () => {
    const output = collector();
    let notifyCalls = 0;
    await runWatch({
      toolSet: pollToolSet([JSON.stringify({ runs: [] })]),
      output: output.stream,
      notify: () => notifyCalls++,
      sleep: async () => {},
      intervalMs: 1,
      shouldContinue: () => false,
    });
    assert.equal(output.text(), '');
    assert.equal(notifyCalls, 0);
  });
});
