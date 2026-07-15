import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_SCHEMA, SEVERITY_ORDER, coerceReviewResult } from '../index.ts';

describe('REVIEW_SCHEMA', () => {
  it('строгая схема с обёрткой-объектом и перечислением категорий', () => {
    const props = REVIEW_SCHEMA.schema.properties as Record<string, unknown>;
    assert.ok('findings' in props && 'summary' in props);
    assert.equal(REVIEW_SCHEMA.strict, true);
    const item = (props.findings as { items: { properties: Record<string, { enum?: string[] }> } })
      .items;
    assert.deepEqual(item.properties.severity.enum, SEVERITY_ORDER);
  });
});

describe('coerceReviewResult', () => {
  it('разбирает валидные находки и сводку', () => {
    const result = coerceReviewResult({
      findings: [{ file: 'a.ts', line: 3, severity: 'bug', title: 'т', body: 'б' }],
      summary: 'итог',
    });
    assert.deepEqual(result, {
      findings: [{ file: 'a.ts', line: 3, severity: 'bug', title: 'т', body: 'б' }],
      summary: 'итог',
    });
  });

  it('отбрасывает записи без файла/строки/текста (нет якоря для инлайна)', () => {
    const result = coerceReviewResult({
      findings: [
        { file: '', line: 1, severity: 'bug', title: 'т', body: 'б' }, // нет файла
        { file: 'a.ts', line: 0, severity: 'bug', title: 'т', body: 'б' }, // строка не >0
        { file: 'a.ts', line: 1.5, severity: 'bug', title: 'т', body: 'б' }, // не целое
        { file: 'a.ts', line: 2, severity: 'bug', title: '', body: '' }, // нет текста
        'мусор',
        null,
        { file: 'a.ts', line: 5, severity: 'bug', title: 'ок', body: '' }, // валидна (есть title)
      ],
      summary: 'x',
    });
    assert.deepEqual(result.findings, [
      { file: 'a.ts', line: 5, severity: 'bug', title: 'ок', body: '' },
    ]);
  });

  it('незнакомая категория сводится к рекомендации (не теряем находку)', () => {
    const result = coerceReviewResult({
      findings: [{ file: 'a.ts', line: 1, severity: 'выдумка', title: 'т', body: 'б' }],
      summary: '',
    });
    assert.equal(result.findings[0].severity, 'recommendation');
  });

  it('findings не массив и summary не строка — пустой список и пустая сводка', () => {
    assert.deepEqual(coerceReviewResult({ findings: 'нет', summary: 42 }), {
      findings: [],
      summary: '',
    });
    assert.deepEqual(coerceReviewResult({}), { findings: [], summary: '' });
  });
});
