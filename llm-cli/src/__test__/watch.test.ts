import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { runWatch, tzLabel } from '../index.ts';
import type { ToolSet } from '../index.ts';

/** Фиксированное «сейчас» для меток времени в логе (детерминизм тестов). */
const now = () => new Date('2026-06-29T09:00:03');

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

/** Набор с poll_results, где шаги — либо JSON-ответ, либо Error (бросается). */
function pollToolSetSeq(steps: (string | Error)[]): ToolSet {
  let index = 0;
  return {
    specs: () => [{ name: 's__poll_results', description: '', parameters: {} }],
    call: async () => {
      const step = steps[Math.min(index++, steps.length - 1)];
      if (step instanceof Error) {
        throw step;
      }
      return step;
    },
  };
}

describe('tzLabel', () => {
  it('форматирует смещение в UTC±H[:MM]', () => {
    assert.equal(tzLabel(300), 'UTC+5'); // Екатеринбург
    assert.equal(tzLabel(0), 'UTC+0');
    assert.equal(tzLabel(-300), 'UTC-5');
    assert.equal(tzLabel(-210), 'UTC-3:30'); // получасовой пояс
    assert.equal(tzLabel(90), 'UTC+1:30');
  });
});

describe('runWatch', () => {
  it('базовый курсор без шума, затем уведомляет о новом запуске (с меткой времени и поясом)', async () => {
    const output = collector();
    const notified: { title: string; message: string }[] = [];
    const toolSet = pollToolSet([
      JSON.stringify({ runs: [{ firedAt: 't0', taskTitle: 'base', ok: true, text: 'old' }] }), // базовый — игнор
      JSON.stringify({
        runs: [
          { firedAt: '2026-06-29T07:00:00+05:00', taskTitle: 'Погода', ok: true, text: 'тепло' },
        ],
      }),
    ]);
    let iterations = 0;
    await runWatch({
      toolSet,
      output: output.stream,
      notify: (title, message) => notified.push({ title, message }),
      sleep: async () => {},
      intervalMs: 1,
      shouldContinue: () => iterations++ < 1,
      now,
    });
    // Метка: [ДД.ММ ЧЧ:ММ:СС UTC±H] из firedAt, затем сам результат.
    assert.match(
      output.text(),
      /🔔 \[\d{2}\.\d{2} \d{2}:\d{2}:\d{2} UTC[+-]\d[^\]]*\] ✓ Погода: тепло/,
    );
    assert.deepEqual(notified, [{ title: 'Планировщик: Погода', message: 'тепло' }]);
  });

  it('неуспешный запуск помечается ✗', async () => {
    const output = collector();
    const toolSet = pollToolSet([
      JSON.stringify({ runs: [] }),
      JSON.stringify({
        runs: [
          { firedAt: '2026-06-29T08:00:00+05:00', taskTitle: 'OCR', ok: false, text: 'недоступен' },
        ],
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
      now,
    });
    assert.match(output.text(), /🔔 \[[^\]]+\] ✗ OCR: недоступен/);
  });

  it('нераспознанный firedAt (не дата) → показывается как есть', async () => {
    const output = collector();
    const toolSet = pollToolSet([
      JSON.stringify({ runs: [] }),
      JSON.stringify({
        runs: [{ firedAt: 'cursor-x', taskTitle: 'Заметка', ok: true, text: 'ок' }],
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
      now,
    });
    assert.match(output.text(), /🔔 \[cursor-x\] ✓ Заметка: ок/);
  });

  it('сбой базового опроса не роняет наблюдатель: базу берём при первом успехе, потом шумим', async () => {
    const output = collector();
    const notified: { title: string; message: string }[] = [];
    const toolSet = pollToolSetSeq([
      new Error('MCP error -32001: Request timed out'), // базовый опрос — сбой
      JSON.stringify({ runs: [{ firedAt: 't1', taskTitle: 'старое', ok: true, text: 'old' }] }), // станет базой
      JSON.stringify({ runs: [{ firedAt: 't2', taskTitle: 'Погода', ok: true, text: 'тепло' }] }), // новый
    ]);
    let iterations = 0;
    await runWatch({
      toolSet,
      output: output.stream,
      notify: (title, message) => notified.push({ title, message }),
      sleep: async () => {},
      intervalMs: 1,
      shouldContinue: () => iterations++ < 2,
      now,
    });
    // У ошибки — метка текущего времени.
    assert.match(
      output.text(),
      /⚠ \[\d{2}\.\d{2} \d{2}:\d{2}:\d{2} UTC[+-]\d[^\]]*\] не удалось взять базовый курсор/,
    );
    assert.match(output.text(), /Request timed out/);
    assert.deepEqual(notified, [{ title: 'Планировщик: Погода', message: 'тепло' }]); // «старое» не шумело
  });

  it('сбой опроса в цикле логируется и не прерывает слежение', async () => {
    const output = collector();
    const notified: string[] = [];
    const toolSet = pollToolSetSeq([
      JSON.stringify({ runs: [] }), // базовый ок
      new Error('MCP error -32001: Request timed out'), // опрос в цикле — сбой
      JSON.stringify({ runs: [{ firedAt: 't1', taskTitle: 'OCR', ok: true, text: 'готово' }] }),
    ]);
    let iterations = 0;
    await runWatch({
      toolSet,
      output: output.stream,
      notify: title => notified.push(title),
      sleep: async () => {},
      intervalMs: 1,
      shouldContinue: () => iterations++ < 2,
      now,
    });
    assert.match(output.text(), /⚠ \[[^\]]+\] опрос планировщика не удался/);
    assert.deepEqual(notified, ['Планировщик: OCR']); // после сбоя слежение продолжилось
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
      now,
    });
    assert.equal(output.text(), '');
    assert.equal(notifyCalls, 0);
  });
});
