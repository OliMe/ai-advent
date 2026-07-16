import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchResult } from '../index.ts';

describe('parseSearchResult', () => {
  it('разбирает фрагменты (chunk_id, source/file/section, score, тело) и уверенность', () => {
    const text =
      'Найдено фрагментов: 2 по запросу «q»:\n' +
      '🔎 кандидатов 20 → rerank(mmr): 2 · уверенность 0.59\n\n' +
      '[1] places.md#0 · /docs › places.md › Places MCP (0.588)\n' +
      'Инструмент find_places ищет организации рядом.\n\n' +
      '[2] scheduler.md#1 · /docs › scheduler.md › Расписание (0.500)\n' +
      'Планировщик задач.';
    const parsed = parseSearchResult(text);
    assert.equal(parsed.confidence, 0.59);
    assert.equal(parsed.lowConfidence, false);
    assert.equal(parsed.chunks.length, 2);
    assert.deepEqual(parsed.chunks[0], {
      chunk_id: 'places.md#0',
      source: '/docs',
      file: 'places.md',
      section: 'Places MCP',
      score: 0.588,
      text: 'Инструмент find_places ищет организации рядом.',
    });
    assert.equal(parsed.chunks[1].chunk_id, 'scheduler.md#1');
    assert.equal(parsed.chunks[1].section, 'Расписание');
  });

  it('границы — по заголовкам: пустая строка внутри тела не разрывает фрагмент', () => {
    const text =
      '[1] a#0 · /d › a.md › Раздел (0.700)\n' +
      'Первый абзац.\n\n' +
      'Второй абзац того же чанка.\n\n' +
      '[2] b#0 · /d › b.md › Другой (0.600)\n' +
      'Тело B.';
    const parsed = parseSearchResult(text);
    assert.equal(parsed.chunks.length, 2);
    assert.equal(parsed.chunks[0].text, 'Первый абзац.\n\nВторой абзац того же чанка.');
  });

  it('секция с «›» внутри собирается целиком', () => {
    const parsed = parseSearchResult('[1] c#0 · /d › f.md › A › B (0.900)\nтело');
    assert.equal(parsed.chunks[0].section, 'A › B');
  });

  it('низкая уверенность: пометка «(низкая)» или «⚠ Низкая уверенность»', () => {
    assert.equal(parseSearchResult('🔎 ... · уверенность 0.42 (низкая)').lowConfidence, true);
    assert.equal(
      parseSearchResult('нет фрагментов\n⚠ Низкая уверенность контекста (лучший косинус 0.30).')
        .lowConfidence,
      true,
    );
  });

  it('пустой результат: нет фрагментов, confidence из трассы или null', () => {
    const empty = parseSearchResult('По запросу «q» релевантных фрагментов не найдено.\n🔎 ...');
    assert.deepEqual(empty.chunks, []);
    assert.equal(empty.confidence, null);
    assert.equal(empty.lowConfidence, false);
  });
});
