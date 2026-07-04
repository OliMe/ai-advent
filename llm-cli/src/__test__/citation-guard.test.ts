import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeForMatch,
  parseAnswerSections,
  validateCitations,
  enforceCitations,
  resolveRagAnswer,
  RAG_DONT_KNOW,
  RAG_UNVERIFIED,
} from '../index.ts';
import type { SearchChunk } from '../index.ts';

const chunk = (over: Partial<SearchChunk> = {}): SearchChunk => ({
  chunk_id: 'doc#0',
  source: '/d',
  file: 'doc.md',
  section: 'Раздел',
  score: 0.8,
  text: 'find_places ищет организации рядом по координатам',
  ...over,
});

/** Валидный ответ: источник реальный, цитата — дословная подстрока чанка. */
const validAnswer =
  'Ответ: find_places ищет рядом.\n' +
  'Источники:\n- /d › doc.md · doc#0\n' +
  'Цитаты:\n- find_places ищет организации рядом';

describe('normalizeForMatch', () => {
  it('снимает markdown/кавычки, схлопывает пробелы, нижний регистр', () => {
    assert.equal(normalizeForMatch('  **Find_Places**\n  ищет  '), 'find_places ищет');
    assert.equal(normalizeForMatch('> «цитата»'), 'цитата');
  });
});

describe('parseAnswerSections', () => {
  it('собирает источники и цитаты, тело «Ответ» игнорирует', () => {
    const parsed = parseAnswerSections(validAnswer);
    assert.deepEqual(parsed.sources, ['/d › doc.md · doc#0']);
    assert.deepEqual(parsed.citations, ['find_places ищет организации рядом']);
  });

  it('markdown-заголовки и инлайновый контент секции', () => {
    const parsed = parseAnswerSections(
      '**Ответ:** текст\n**Источники:** /d › doc.md · doc#0\n**Цитаты:**\n> цитата один',
    );
    assert.deepEqual(parsed.sources, ['/d › doc.md · doc#0']);
    assert.deepEqual(parsed.citations, ['цитата один']);
  });

  it('строки вне секций игнорируются', () => {
    assert.deepEqual(parseAnswerSections('просто текст без секций'), {
      sources: [],
      citations: [],
    });
  });
});

describe('validateCitations', () => {
  it('валидный ответ проходит', () => {
    assert.deepEqual(validateCitations(validAnswer, [chunk()]), { ok: true, reason: '' });
  });

  it('нет источников → отказ', () => {
    const r = validateCitations('Ответ: x\nЦитаты:\n- find_places ищет организации рядом', [
      chunk(),
    ]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /Источники/);
  });

  it('нет цитат → отказ', () => {
    const r = validateCitations('Ответ: x\nИсточники:\n- /d › doc.md · doc#0', [chunk()]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /Цитаты/);
  });

  it('выдуманный источник → отказ', () => {
    const r = validateCitations(
      'Ответ: x\nИсточники:\n- other.md\nЦитаты:\n- find_places ищет организации рядом',
      [chunk()],
    );
    assert.equal(r.ok, false);
    assert.match(r.reason, /источник не найден/);
  });

  it('слишком длинная цитата → отказ', () => {
    const long = 'a'.repeat(241);
    const r = validateCitations(`Ответ: x\nИсточники:\n- /d › doc.md · doc#0\nЦитаты:\n- ${long}`, [
      chunk({ text: long }),
    ]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /длиннее/);
  });

  it('невыводимая (не дословная) цитата → отказ', () => {
    const r = validateCitations(
      'Ответ: x\nИсточники:\n- /d › doc.md · doc#0\nЦитаты:\n- это выдуманная цитата',
      [chunk()],
    );
    assert.equal(r.ok, false);
    assert.match(r.reason, /не найдена дословно/);
  });
});

describe('enforceCitations', () => {
  it('валидный с первого раза → без перегенерации', async () => {
    let calls = 0;
    const out = await enforceCitations({
      initial: validAnswer,
      chunks: [chunk()],
      regenerate: async () => {
        calls++;
        return validAnswer;
      },
    });
    assert.equal(out, validAnswer);
    assert.equal(calls, 0);
  });

  it('провал → перегенерация → успех; onFailure вызван', async () => {
    const failures: string[] = [];
    const out = await enforceCitations({
      initial: 'Ответ: x\nИсточники:\n- other.md\nЦитаты:\n- нет',
      chunks: [chunk()],
      regenerate: async () => validAnswer,
      onFailure: reason => failures.push(reason),
    });
    assert.equal(out, validAnswer);
    assert.equal(failures.length, 1);
  });

  it('перегенерации исчерпаны → безопасный фолбэк', async () => {
    const bad = 'Ответ: x\nИсточники:\n- other.md\nЦитаты:\n- нет';
    const out = await enforceCitations({
      initial: bad,
      chunks: [chunk()],
      regenerate: async () => bad,
      maxRegenerations: 1,
    });
    assert.equal(out, RAG_UNVERIFIED);
  });
});

describe('resolveRagAnswer', () => {
  const searchResult =
    'Найдено фрагментов: 1 по запросу «q»:\n' +
    '🔎 кандидатов 1 → rerank(none): 1 · уверенность 0.80\n\n' +
    '[1] doc#0 · /d › doc.md › Раздел (0.800)\n' +
    'find_places ищет организации рядом по координатам';

  it('нет контекста (пустые результаты) → «не знаю»', async () => {
    const out = await resolveRagAnswer({
      ragResults: [],
      initial: validAnswer,
      regenerate: async () => validAnswer,
    });
    assert.equal(out, RAG_DONT_KNOW);
  });

  it('слабая уверенность (все результаты low) → «не знаю»', async () => {
    const low = searchResult.replace('0.80', '0.30 (низкая)');
    const out = await resolveRagAnswer({
      ragResults: [low],
      initial: validAnswer,
      regenerate: async () => validAnswer,
    });
    assert.equal(out, RAG_DONT_KNOW);
  });

  it('есть контекст + валидный ответ → пропускает', async () => {
    const out = await resolveRagAnswer({
      ragResults: [searchResult],
      initial: validAnswer,
      regenerate: async () => validAnswer,
    });
    assert.equal(out, validAnswer);
  });

  it('есть контекст + невалидный ответ → перегенерация', async () => {
    let regenerated = false;
    const out = await resolveRagAnswer({
      ragResults: [searchResult],
      initial: 'Ответ: x\nИсточники:\n- other.md\nЦитаты:\n- выдумка',
      regenerate: async () => {
        regenerated = true;
        return validAnswer;
      },
    });
    assert.equal(regenerated, true);
    assert.equal(out, validAnswer);
  });
});
