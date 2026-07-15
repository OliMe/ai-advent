import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { severityRank, meetsSeverity, dedupeFindings, postprocessFindings } from '../index.ts';
import type { Finding, FindingSeverity } from '../index.ts';

const finding = (file: string, line: number, severity: FindingSeverity, title = 'т'): Finding => ({
  file,
  line,
  severity,
  title,
  body: 'б',
});

describe('severityRank / meetsSeverity', () => {
  it('bug серьёзнее nitpick; порог включает не менее серьёзные', () => {
    assert.ok(severityRank('bug') < severityRank('nitpick'));
    assert.equal(meetsSeverity('bug', 'architecture'), true);
    assert.equal(meetsSeverity('architecture', 'architecture'), true);
    assert.equal(meetsSeverity('recommendation', 'architecture'), false);
    assert.equal(meetsSeverity('nitpick', 'nitpick'), true);
  });
});

describe('dedupeFindings', () => {
  it('одна строка — одна находка, остаётся самая серьёзная, порядок стабилен', () => {
    const result = dedupeFindings([
      finding('a.ts', 1, 'nitpick', 'мелочь'),
      finding('a.ts', 1, 'bug', 'баг'), // вытесняет nitpick на той же строке
      finding('a.ts', 1, 'recommendation', 'совет'), // менее серьёзно — не вытесняет
      finding('b.ts', 2, 'recommendation', 'другое'),
    ]);
    assert.deepEqual(
      result.map(f => [f.file, f.line, f.severity, f.title]),
      [
        ['a.ts', 1, 'bug', 'баг'],
        ['b.ts', 2, 'recommendation', 'другое'],
      ],
    );
  });
});

describe('postprocessFindings', () => {
  it('порог: менее серьёзные инлайн уходят в сводку', () => {
    const result = postprocessFindings(
      {
        inline: [
          finding('a.ts', 1, 'bug'),
          finding('a.ts', 2, 'recommendation'),
          finding('a.ts', 3, 'nitpick'),
        ],
        general: [],
      },
      { minSeverity: 'architecture', maxInline: 20 },
    );
    assert.deepEqual(
      result.inline.map(f => f.line),
      [1],
    );
    assert.deepEqual(
      result.general.map(f => f.line).sort((a, b) => a - b),
      [2, 3],
    );
  });

  it('инлайн отсортирован по важности; лимит переносит лишнее в сводку', () => {
    const result = postprocessFindings(
      {
        inline: [
          finding('a.ts', 1, 'nitpick'),
          finding('a.ts', 2, 'bug'),
          finding('a.ts', 3, 'architecture'),
        ],
        general: [],
      },
      { minSeverity: 'nitpick', maxInline: 2 },
    );
    // Сортировка: bug(2), architecture(3), nitpick(1). Лимит 2 → инлайн [2,3], перенос [1].
    assert.deepEqual(
      result.inline.map(f => f.line),
      [2, 3],
    );
    assert.deepEqual(
      result.general.map(f => f.line),
      [1],
    );
  });

  it('дедуп до порога/лимита; общие из validate сохраняются', () => {
    const result = postprocessFindings(
      {
        inline: [finding('a.ts', 1, 'recommendation'), finding('a.ts', 1, 'bug')],
        general: [finding('c.ts', 9, 'architecture', 'общее')],
      },
      { minSeverity: 'nitpick', maxInline: 20 },
    );
    assert.deepEqual(
      result.inline.map(f => [f.line, f.severity]),
      [[1, 'bug']],
    );
    // Общая находка из validate осталась в сводке.
    assert.ok(result.general.some(f => f.title === 'общее'));
  });
});
