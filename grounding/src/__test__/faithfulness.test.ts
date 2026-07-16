import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFaithfulnessVerdict, enforceFaithfulness } from '../index.ts';
import type { SearchChunk } from '../index.ts';
import type { Conversation } from '../../../core/src/index.ts';

const chunk = (text: string): SearchChunk => ({
  chunk_id: 'd#0',
  source: '/d',
  file: 'd.md',
  section: 'S',
  score: 0.8,
  text,
});

/** Фейковый судья: возвращает ответы по очереди (по одному на проверку). */
const checkerReturning = (...replies: string[]): (() => Conversation) => {
  let call = 0;
  return () =>
    ({
      ask: async () => ({ content: replies[Math.min(call++, replies.length - 1)] }),
    }) as unknown as Conversation;
};

describe('parseFaithfulnessVerdict', () => {
  it('«OK» или пусто → достоверно', () => {
    assert.deepEqual(parseFaithfulnessVerdict('OK'), { faithful: true, issues: [] });
    assert.deepEqual(parseFaithfulnessVerdict('  '), { faithful: true, issues: [] });
    assert.deepEqual(parseFaithfulnessVerdict('OK, всё подкреплено'), {
      faithful: true,
      issues: [],
    });
  });

  it('перечень утверждений → недостоверно, маркеры сняты', () => {
    const v = parseFaithfulnessVerdict('- утверждение A без опоры\n* утверждение B');
    assert.equal(v.faithful, false);
    assert.deepEqual(v.issues, ['утверждение A без опоры', 'утверждение B']);
  });

  it('только пустые строки после снятия маркеров → достоверно', () => {
    assert.deepEqual(parseFaithfulnessVerdict('-\n*'), { faithful: true, issues: [] });
  });
});

describe('enforceFaithfulness', () => {
  const opts = (over: Partial<Parameters<typeof enforceFaithfulness>[0]> = {}) => ({
    initial: 'ответ',
    chunks: [chunk('источник текст')],
    makeChecker: checkerReturning('OK'),
    regenerate: async () => 'перегенерённый',
    fallback: 'ФОЛБЭК',
    ...over,
  });

  it('достоверно с первого раза → без перегенерации', async () => {
    let regen = 0;
    const out = await enforceFaithfulness(
      opts({
        regenerate: async () => {
          regen++;
          return 'x';
        },
      }),
    );
    assert.equal(out, 'ответ');
    assert.equal(regen, 0);
  });

  it('недостоверно → перегенерация → достоверно; onUnfaithful вызван', async () => {
    const issues: string[][] = [];
    const out = await enforceFaithfulness(
      opts({
        makeChecker: checkerReturning('- выдумка про X', 'OK'),
        regenerate: async () => 'исправленный',
        onUnfaithful: list => issues.push(list),
      }),
    );
    assert.equal(out, 'исправленный');
    assert.deepEqual(issues, [['выдумка про X']]);
  });

  it('перегенерации исчерпаны → фолбэк', async () => {
    const out = await enforceFaithfulness(
      opts({
        makeChecker: checkerReturning('- всё ещё выдумка'),
        maxRegenerations: 1,
      }),
    );
    assert.equal(out, 'ФОЛБЭК');
  });
});
