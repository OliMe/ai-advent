import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  repoWebBaseFromTicketUrl,
  buildSourceLinkContext,
  githubHeadingAnchor,
  linkifySources,
} from '../index.ts';
import type { SearchChunk } from '../../../grounding/src/index.ts';

const CHUNKS: SearchChunk[] = [
  {
    chunk_id: 'authorization.md#1',
    source: '/repo/support-bot/faq',
    file: 'authorization.md',
    section: 'Почему не работает авторизация к LLM-эндпоинту?',
    score: 0.9,
    text: 'Проверьте заголовок Authorization.',
  },
  {
    chunk_id: 'authorization.md#2',
    source: '/repo/support-bot/faq',
    file: 'authorization.md',
    section: 'Что означает ответ 401, а что 403?',
    score: 0.8,
    text: '401 — токен не совпал.',
  },
];

describe('repoWebBaseFromTicketUrl', () => {
  it('вырезает базу репозитория до /issues/', () => {
    assert.equal(
      repoWebBaseFromTicketUrl('https://github.com/OliMe/ai-advent/issues/5'),
      'https://github.com/OliMe/ai-advent',
    );
  });

  it('нет /issues/ → null', () => {
    assert.equal(repoWebBaseFromTicketUrl('https://example/x'), null);
  });
});

describe('buildSourceLinkContext', () => {
  it('собирает blob-базу из url + ref', () => {
    const ctx = buildSourceLinkContext('https://github.com/o/r/issues/1', 'abc123', '/repo');
    assert.deepEqual(ctx, { blobBaseUrl: 'https://github.com/o/r/blob/abc123', repoRoot: '/repo' });
  });

  it('нераспознанный url → null', () => {
    assert.equal(buildSourceLinkContext('нет', 'main', '/repo'), null);
  });

  it('пустой ref или корень → null', () => {
    assert.equal(buildSourceLinkContext('https://github.com/o/r/issues/1', '', '/repo'), null);
    assert.equal(buildSourceLinkContext('https://github.com/o/r/issues/1', 'main', ''), null);
  });
});

describe('githubHeadingAnchor', () => {
  it('нижний регистр, убирает пунктуацию, пробелы → дефисы, кириллица и дефис сохранены', () => {
    assert.equal(
      githubHeadingAnchor('Почему не работает авторизация к LLM-эндпоинту?'),
      'почему-не-работает-авторизация-к-llm-эндпоинту',
    );
  });

  it('запятые и знаки убираются, цифры остаются', () => {
    assert.equal(
      githubHeadingAnchor('Что означает ответ 401, а что 403?'),
      'что-означает-ответ-401-а-что-403',
    );
  });
});

describe('linkifySources', () => {
  const context = { blobBaseUrl: 'https://github.com/o/r/blob/SHA', repoRoot: '/repo' };

  const answer = [
    'Ответ: текст.',
    'Источники:',
    '- authorization.md › Почему не работает авторизация к LLM-эндпоинту?',
    '- authorization.md › Что означает ответ 401, а что 403?',
    'Цитаты:',
    '- «authorization.md › не ссылка»',
  ].join('\n');

  it('пункты «Источников»: файл → ссылка на файл, раздел → ссылка на секцию; «Цитаты» не трогаются', () => {
    const out = linkifySources(answer, CHUNKS, context);
    const base = 'https://github.com/o/r/blob/SHA/support-bot/faq/authorization.md';
    // Часть-файл — ссылка на файл БЕЗ якоря; часть-раздел — отдельная ссылка с якорем секции.
    assert.match(
      out,
      new RegExp(
        `- \\[authorization\\.md\\]\\(${base.replace(/[.]/g, '\\.')}\\) › \\[Почему.*\\]\\(${base.replace(/[.]/g, '\\.')}#почему-не-работает-авторизация-к-llm-эндпоинту\\)`,
      ),
    );
    assert.match(
      out,
      /\[Что означает ответ 401, а что 403\?\]\(.*authorization\.md#что-означает-ответ-401-а-что-403\)/,
    );
    // строка в «Цитатах» осталась простым текстом (без markdown-ссылки)
    assert.match(out, /- «authorization\.md › не ссылка»/);
    assert.doesNotMatch(out, /не ссылка»\]\(/);
  });

  it('нет контекста → ответ без изменений', () => {
    assert.equal(linkifySources(answer, CHUNKS, null), answer);
  });

  it('нет чанков → ответ без изменений', () => {
    assert.equal(linkifySources(answer, [], context), answer);
  });

  it('метка без разделителя, совпал только файл → одна ссылка на файл без якоря', () => {
    const out = linkifySources(
      'Источники:\n- authorization.md (общий раздел без совпадения)',
      CHUNKS,
      context,
    );
    assert.match(out, /\/support-bot\/faq\/authorization\.md\)/);
    assert.doesNotMatch(out, /authorization\.md#/);
  });

  it('есть разделитель, но раздел не сопоставлен → файл ссылкой, раздел текстом', () => {
    const out = linkifySources(
      'Источники:\n- authorization.md › Несуществующий раздел',
      CHUNKS,
      context,
    );
    assert.match(out, /- \[authorization\.md\]\(.*authorization\.md\) › Несуществующий раздел$/);
    assert.doesNotMatch(out, /authorization\.md#/); // якоря нет — раздел не сопоставлен
  });

  it('разделитель есть, но одна из частей пуста → одна ссылка (метка целиком)', () => {
    // «authorization.md ›» — часть-раздел пустая → splitSourceLabel возвращает null → одна ссылка.
    const out = linkifySources('Источники:\n- authorization.md ›', CHUNKS, context);
    assert.match(out, /- \[authorization\.md ›\]\(.*authorization\.md\)$/);
  });

  it('метка с chunk_id после · → раздел берётся до ·, файл и секция ссылками', () => {
    const out = linkifySources(
      'Источники:\n- authorization.md › Что означает ответ 401, а что 403? · authorization.md#2',
      CHUNKS,
      context,
    );
    assert.match(
      out,
      /- \[authorization\.md\]\(.*authorization\.md\) › \[Что означает ответ 401, а что 403\?\]\(.*#что-означает-ответ-401-а-что-403\)/,
    );
  });

  it('метка начинается с разделителя (часть-файл пустая) → одна ссылка целиком', () => {
    const out = linkifySources('Источники:\n- › authorization.md подробнее', CHUNKS, context);
    assert.match(out, /- \[› authorization\.md подробнее\]\(.*authorization\.md\)$/);
  });

  it('код-источник (раздел = инструмент git-mcp) → ссылка на файл без битого якоря', () => {
    const codeChunks: SearchChunk[] = [
      {
        chunk_id: 'проект › support-mcp/src/loop-guard.ts',
        source: '/repo',
        file: 'support-mcp/src/loop-guard.ts',
        section: 'read_file',
        score: 1,
        text: 'export function hasSupportMarker() {}',
      },
    ];
    const out = linkifySources(
      'Источники:\n- support-mcp/src/loop-guard.ts › read_file',
      codeChunks,
      context,
    );
    // Одна ссылка на файл, без «› read_file» и без якоря #read_file.
    assert.match(
      out,
      /- \[support-mcp\/src\/loop-guard\.ts\]\(.*\/support-mcp\/src\/loop-guard\.ts\)$/,
    );
    assert.doesNotMatch(out, /#read_file/);
    assert.doesNotMatch(out, /› \[read_file\]/);
  });

  it('git_grep-чанк (file=шаблон) пропускается — ссылка строится на read_file (реальный путь)', () => {
    const codeChunks: SearchChunk[] = [
      // git_grep-чанк идёт ПЕРВЫМ, но его file — шаблон «loop-guard», не путь.
      {
        chunk_id: 'проект › loop-guard',
        source: '/repo',
        file: 'loop-guard',
        section: 'git_grep',
        score: 1,
        text: 'support-mcp/src/loop-guard.ts:1:export const SUPPORT_MARKER',
      },
      // read_file-чанк с реальным путём.
      {
        chunk_id: 'проект › support-mcp/src/loop-guard.ts',
        source: '/repo',
        file: 'support-mcp/src/loop-guard.ts',
        section: 'read_file',
        score: 1,
        text: 'export const SUPPORT_MARKER = ...',
      },
    ];
    const out = linkifySources('Источники:\n- support-mcp/src/loop-guard.ts', codeChunks, context);
    // Полный путь, а не обрезанный «loop-guard».
    assert.match(
      out,
      /\[support-mcp\/src\/loop-guard\.ts\]\(.*\/support-mcp\/src\/loop-guard\.ts\)$/,
    );
    assert.doesNotMatch(out, /blob\/SHA\/loop-guard\)/);
  });

  it('источник не сопоставлен с чанком → строка как есть', () => {
    const out = linkifySources('Источники:\n- unknown.md › раздел', CHUNKS, context);
    assert.match(out, /- unknown\.md › раздел$/);
    assert.doesNotMatch(out, /\]\(/);
  });

  it('пустой пункт-маркер в «Источниках» пропускается', () => {
    const out = linkifySources('Источники:\n- \nОтвет: конец', CHUNKS, context);
    assert.match(out, /Источники:\n- \nОтвет: конец/);
  });

  it('строка-пункт вне «Источников» (после «Ответ») не трогается', () => {
    const out = linkifySources(
      'Ответ:\n- authorization.md › Что означает ответ 401, а что 403?',
      CHUNKS,
      context,
    );
    assert.doesNotMatch(out, /\]\(/);
  });
});
