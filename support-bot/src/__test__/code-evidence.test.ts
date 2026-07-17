import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gatherCodeEvidence } from '../index.ts';
import type { ChatMessage, ToolSet } from '../../../core/src/index.ts';

/** Фейковый git-ToolSet: git_list_files/git_grep/read_file по суффиксу имени. */
function gitToolSet(handlers: Record<string, (args: Record<string, unknown>) => string>): ToolSet {
  const names = {
    list: 'git__git_list_files',
    grep: 'git__git_grep',
    read: 'git__read_file',
  };
  return {
    specs: () =>
      [names.list, names.grep, names.read]
        .filter(name => name.split('__')[1] in handlers || true)
        .map(name => ({ name, description: '', parameters: {} })),
    call: async (name, args) => {
      const suffix = name.split('__')[1];
      return handlers[suffix] ? handlers[suffix](args) : '';
    },
  };
}

const complete =
  (reply: string) =>
  async (_messages: ChatMessage[]): Promise<string> =>
    reply;

describe('gatherCodeEvidence', () => {
  it('шаблоны → grep → чтение файла → чанки-доказательства и кандидаты', async () => {
    const toolSet = gitToolSet({
      git_list_files: () => 'core/src/config.ts\ncore/src/auth.ts',
      git_grep: () => 'core/src/auth.ts:12:export function authorize(token) {',
      read_file: () => 'export function authorize(token) {\n  return check(token);\n}',
    });
    const evidence = await gatherCodeEvidence(
      { toolSet, repoRoot: '/repo', complete: complete('authorize') },
      'как устроена авторизация?',
    );
    assert.ok(evidence.chunks.length >= 1);
    // Есть чанк с телом прочитанного файла.
    assert.ok(evidence.chunks.some(chunk => chunk.text.includes('function authorize')));
    // Кандидаты — строки, содержащие шаблон.
    assert.ok(evidence.candidates.some(line => line.includes('authorize')));
  });

  it('шаблон = имя файла → файл читается целиком (по прямому указанию)', async () => {
    let readPath = '';
    const toolSet = gitToolSet({
      git_list_files: () => 'src/authorize.ts\nsrc/other.ts',
      git_grep: () => '',
      read_file: args => {
        readPath = String(args.path);
        return 'export function authorize() {}';
      },
    });
    const evidence = await gatherCodeEvidence(
      { toolSet, repoRoot: '/repo', complete: complete('authorize') },
      'где авторизация?',
    );
    assert.equal(readPath, 'src/authorize.ts'); // файл по имени-шаблону прочитан
    assert.ok(evidence.chunks.some(chunk => chunk.text.includes('function authorize')));
  });

  it('нет git_list_files → список пуст, поиск всё равно идёт по grep', async () => {
    const toolSet: ToolSet = {
      specs: () => [
        { name: 'git__git_grep', description: '', parameters: {} },
        { name: 'git__read_file', description: '', parameters: {} },
      ],
      call: async name =>
        name.endsWith('git_grep') ? 'src/a.ts:1:authorize here' : 'authorize file body',
    };
    const evidence = await gatherCodeEvidence(
      { toolSet, repoRoot: '/repo', complete: complete('authorize') },
      'вопрос',
    );
    assert.ok(evidence.chunks.length >= 1);
  });

  it('модель не назвала шаблонов (вопрос не о коде) → пусто, без grep', async () => {
    let grepCalled = false;
    const toolSet = gitToolSet({
      git_list_files: () => 'a.ts',
      git_grep: () => {
        grepCalled = true;
        return '';
      },
    });
    const evidence = await gatherCodeEvidence(
      { toolSet, repoRoot: '/repo', complete: complete('') },
      'спасибо!',
    );
    assert.deepEqual(evidence, { chunks: [], candidates: [] });
    assert.equal(grepCalled, false);
  });

  it('нет инструмента git_grep → пустой результат (мягко)', async () => {
    const toolSet: ToolSet = {
      specs: () => [{ name: 'git__git_list_files', description: '', parameters: {} }],
      call: async () => 'a.ts',
    };
    const evidence = await gatherCodeEvidence(
      { toolSet, repoRoot: '/repo', complete: complete('pattern') },
      'вопрос',
    );
    assert.deepEqual(evidence.chunks, []);
  });

  it('onToolCall вызывается на grep и чтении', async () => {
    const calls: string[] = [];
    const toolSet = gitToolSet({
      git_list_files: () => 'auth.ts',
      git_grep: () => 'auth.ts:1:authorize',
      read_file: () => 'authorize code',
    });
    await gatherCodeEvidence(
      {
        toolSet,
        repoRoot: '/repo',
        complete: complete('authorize'),
        onToolCall: name => calls.push(name),
      },
      'вопрос про authorize',
    );
    assert.ok(calls.some(name => name.endsWith('git_grep')));
    assert.ok(calls.some(name => name.endsWith('read_file')));
  });
});
