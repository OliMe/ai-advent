import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { commentableLinesOf, parseUnifiedDiff, fileFromPatch } from '../index.ts';

const PATCH = [
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' const d = 5;',
].join('\n');

describe('commentableLinesOf', () => {
  it('добавленные и контекстные строки комментируемы, удалённые — нет', () => {
    // Ханк начинается с новой строки 1: ctx(1) del(-) add(2) add(3) ctx(4).
    assert.deepEqual(
      [...commentableLinesOf(PATCH)].sort((a, b) => a - b),
      [1, 2, 3, 4],
    );
  });

  it('несколько ханков в одном patch', () => {
    const patch = ['@@ -1,1 +1,2 @@', ' a', '+b', '@@ -10,1 +11,2 @@', ' x', '+y'].join('\n');
    assert.deepEqual(
      [...commentableLinesOf(patch)].sort((a, b) => a - b),
      [1, 2, 11, 12],
    );
  });

  it('служебная строка «\\ No newline» пропускается, мусор до ханка игнорируется', () => {
    const patch = ['мусор', '@@ -1,1 +1,1 @@', '-old', '+new', '\\ No newline at end of file'].join(
      '\n',
    );
    assert.deepEqual([...commentableLinesOf(patch)], [1]);
  });

  it('пустой patch — пустое множество', () => {
    assert.equal(commentableLinesOf('').size, 0);
  });
});

describe('parseUnifiedDiff', () => {
  it('разбирает несколько файлов, статусы и переименование', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      PATCH,
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+line one',
      '+line two',
      'diff --git a/old.ts b/renamed.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to renamed.ts',
    ].join('\n');

    const files = parseUnifiedDiff(diff);
    assert.equal(files.length, 3);

    const [modified, added, renamed] = files;
    assert.deepEqual(
      { path: modified.path, status: modified.status },
      { path: 'src/a.ts', status: 'modified' },
    );
    assert.deepEqual(
      [...modified.commentableLines].sort((a, b) => a - b),
      [1, 2, 3, 4],
    );

    assert.equal(added.path, 'new.ts');
    assert.equal(added.status, 'added');
    assert.deepEqual(
      [...added.commentableLines].sort((a, b) => a - b),
      [1, 2],
    );

    assert.equal(renamed.path, 'renamed.ts');
    assert.equal(renamed.oldPath, 'old.ts');
    assert.equal(renamed.status, 'renamed');
    assert.equal(renamed.commentableLines.size, 0); // переименование без изменений
  });

  it('удаление файла и бинарник', () => {
    const diff = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
      'diff --git a/img.png b/img.png',
      'index 333..444 100644',
      'Binary files a/img.png and b/img.png differ',
    ].join('\n');

    const [removed, binary] = parseUnifiedDiff(diff);
    assert.equal(removed.path, 'gone.ts');
    assert.equal(removed.status, 'removed');
    assert.equal(removed.commentableLines.size, 0); // только удалённые строки
    assert.equal(binary.path, 'img.png');
    assert.equal(binary.status, 'binary');
  });

  it('файл без ханков и без спец-маркеров (смена режима) → renamed-фолбэк', () => {
    const diff = ['diff --git a/x.ts b/x.ts', 'old mode 100644', 'new mode 100755'].join('\n');
    const [file] = parseUnifiedDiff(diff);
    assert.equal(file.path, 'x.ts');
    assert.equal(file.status, 'renamed');
    assert.equal(file.commentableLines.size, 0);
  });

  it('секция без определимого пути отбрасывается; пустой diff — пусто', () => {
    assert.deepEqual(parseUnifiedDiff(''), []);
    assert.deepEqual(parseUnifiedDiff('просто текст без diff --git'), []);
    // diff --git с невынимаемым путём (сломанный заголовок) → секция без пути отбрасывается.
    assert.deepEqual(parseUnifiedDiff('diff --git сломано\nтело'), []);
  });
});

describe('fileFromPatch', () => {
  it('собирает DiffFile из готовых полей (как из API PR)', () => {
    const file = fileFromPatch('src/a.ts', PATCH, 'modified');
    assert.equal(file.path, 'src/a.ts');
    assert.equal(file.status, 'modified');
    assert.deepEqual(
      [...file.commentableLines].sort((a, b) => a - b),
      [1, 2, 3, 4],
    );
    assert.equal(file.oldPath, undefined);
  });

  it('переименование: oldPath отличается от path', () => {
    const file = fileFromPatch('new.ts', PATCH, 'renamed', 'old.ts');
    assert.equal(file.oldPath, 'old.ts');
    // Тот же путь в oldPath — не сохраняем (не переименование).
    assert.equal(fileFromPatch('x.ts', PATCH, 'modified', 'x.ts').oldPath, undefined);
  });
});
