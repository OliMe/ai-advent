import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isCodeEvidenceTool, toEvidenceChunks, validateCitations } from '../index.ts';

describe('isCodeEvidenceTool', () => {
  it('инструменты кода (с неймспейсом сервера)', () => {
    assert.ok(isCodeEvidenceTool('git__read_file'));
    assert.ok(isCodeEvidenceTool('git__git_grep'));
    assert.ok(isCodeEvidenceTool('git__git_list_files'));
    assert.ok(isCodeEvidenceTool('git__git_diff'));
    assert.ok(isCodeEvidenceTool('git__git_log'));
  });

  it('поиск по документации и посторонние инструменты — не доказательства о коде', () => {
    assert.equal(isCodeEvidenceTool('rag__search_docs'), false);
    assert.equal(isCodeEvidenceTool('git__git_branch'), false);
    assert.equal(isCodeEvidenceTool('scheduler__list_tasks'), false);
  });
});

describe('toEvidenceChunks', () => {
  it('прочитанный файл становится чанком: проект › путь, тело — содержимое', () => {
    const chunks = toEvidenceChunks([
      {
        name: 'git__read_file',
        args: { repo: '/work/shop-api', path: 'src/auth.ts' },
        result: 'export function authorize() {}',
      },
    ]);
    assert.deepEqual(chunks, [
      {
        chunk_id: 'shop-api › src/auth.ts',
        source: '/work/shop-api',
        file: 'src/auth.ts',
        section: 'read_file',
        score: 1,
        text: 'export function authorize() {}',
      },
    ]);
  });

  it('поиск по коду: предметом становится шаблон, подкаталог — если пути нет', () => {
    const [grep, list] = toEvidenceChunks([
      { name: 'git__git_grep', args: { pattern: 'authorize' }, result: 'src/auth.ts:1:authorize' },
      { name: 'git__git_list_files', args: { subdir: 'src' }, result: 'src/auth.ts' },
    ]);
    assert.equal(grep.file, 'authorize');
    assert.equal(grep.chunk_id, 'проект › authorize');
    assert.equal(grep.section, 'git_grep');
    assert.equal(list.file, 'src');
  });

  it('без аргументов предмет — весь репозиторий', () => {
    const [chunk] = toEvidenceChunks([{ name: 'git_diff', args: {}, result: 'diff --git' }]);
    assert.equal(chunk.file, 'репозиторий');
    assert.equal(chunk.section, 'git_diff');
  });

  it('результаты не-кодовых инструментов отбрасываются', () => {
    const chunks = toEvidenceChunks([
      { name: 'rag__search_docs', args: {}, result: '[1] a#1 · s › f › x (0.9)' },
      { name: 'git__git_branch', args: {}, result: 'Ветка: main' },
    ]);
    assert.deepEqual(chunks, []);
  });
});

describe('код как доказательство для цитатного гейта', () => {
  it('дословная цитата КОДА принимается — ответ о коде больше не «не подтверждён»', () => {
    const chunks = toEvidenceChunks([
      {
        name: 'git__read_file',
        args: { repo: '/work/api', path: 'src/auth.ts' },
        result: 'export function authorize(token: string): boolean {\n  return token !== "";\n}',
      },
    ]);
    const answer = [
      'Ответ: авторизация — в src/auth.ts, функция authorize.',
      'Источники:',
      '- api › src/auth.ts',
      'Цитаты:',
      '- «export function authorize(token: string): boolean»',
    ].join('\n');
    assert.deepEqual(validateCitations(answer, chunks), { ok: true, reason: '' });
  });

  it('выдуманный код цитатой не пройдёт (сверка строковая)', () => {
    const chunks = toEvidenceChunks([
      {
        name: 'git__read_file',
        args: { path: 'src/auth.ts' },
        result: 'export function authorize() {}',
      },
    ]);
    const answer = [
      'Ответ: авторизация в src/auth.ts.',
      'Источники:',
      '- src/auth.ts',
      'Цитаты:',
      '- «export function validateJwtToken(secret: string)»',
    ].join('\n');
    const validation = validateCitations(answer, chunks);
    assert.equal(validation.ok, false);
    assert.match(validation.reason, /дословной цитаты-якоря/);
  });
});
