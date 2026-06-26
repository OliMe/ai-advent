import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleReadFile,
  handleWriteFile,
  handleAppendFile,
  handleListDir,
  handleDeletePath,
} from '../index.ts';
import type { DirEntry, FsIo, ToolDeps } from '../index.ts';

const ALLOWED = ['/tmp/fs-test'];

/** Фейковый IO с настраиваемыми stat/list/read и записью мутаций. */
function makeDeps(overrides: Partial<FsIo> = {}): {
  deps: ToolDeps;
  writes: { path: string; content: string }[];
  removed: string[];
} {
  const writes: { path: string; content: string }[] = [];
  const removed: string[] = [];
  const io: FsIo = {
    read: overrides.read ?? (() => 'содержимое'),
    write: overrides.write ?? ((path, content) => writes.push({ path, content })),
    append: overrides.append ?? ((path, content) => writes.push({ path, content })),
    list: overrides.list ?? (() => [] as DirEntry[]),
    stat: overrides.stat ?? (() => 'file'),
    removeFile: overrides.removeFile ?? (path => removed.push(path)),
    removeEmptyDir: overrides.removeEmptyDir ?? (path => removed.push(path)),
  };
  return { deps: { io, allowedDirs: ALLOWED }, writes, removed };
}

describe('handleReadFile', () => {
  it('читает существующий файл', () => {
    const { deps } = makeDeps({ stat: () => 'file', read: () => 'привет' });
    assert.equal(handleReadFile(deps, { path: '/tmp/fs-test/a.md' }), 'привет');
  });
  it('не файл → не найден', () => {
    const { deps } = makeDeps({ stat: () => null });
    assert.match(handleReadFile(deps, { path: '/tmp/fs-test/a.md' }), /Файл не найден/);
  });
  it('пустой path → подсказка', () => {
    assert.match(handleReadFile(makeDeps().deps, {}), /Нужен непустой path/);
  });
  it('путь вне песочницы → ошибка', () => {
    assert.match(handleReadFile(makeDeps().deps, { path: '/etc/passwd' }), /вне разрешённых/);
  });
  it('ошибка не-Error приводится к строке', () => {
    const { deps } = makeDeps({
      stat: () => 'file',
      read: () => {
        throw 'строковый сбой';
      },
    });
    assert.equal(handleReadFile(deps, { path: '/tmp/fs-test/a.md' }), 'строковый сбой');
  });
});

describe('handleWriteFile', () => {
  it('пишет файл и подтверждает', () => {
    const { deps, writes } = makeDeps();
    const result = handleWriteFile(deps, { path: '/tmp/fs-test/a.md', content: 'abc' });
    assert.match(result, /Записано: \/tmp\/fs-test\/a\.md \(3 символов\)/);
    assert.deepEqual(writes, [{ path: '/tmp/fs-test/a.md', content: 'abc' }]);
  });
  it('без content → пустая строка (0 символов)', () => {
    const { deps } = makeDeps();
    assert.match(handleWriteFile(deps, { path: '/tmp/fs-test/a.md' }), /\(0 символов\)/);
  });
  it('пустой path → подсказка; вне песочницы → ошибка', () => {
    assert.match(handleWriteFile(makeDeps().deps, {}), /Нужен непустой path/);
    assert.match(
      handleWriteFile(makeDeps().deps, { path: '/etc/x', content: 'y' }),
      /вне разрешённых/,
    );
  });
});

describe('handleAppendFile', () => {
  it('дописывает и подтверждает', () => {
    const { deps, writes } = makeDeps();
    assert.match(
      handleAppendFile(deps, { path: '/tmp/fs-test/a.md', content: 'хвост' }),
      /Дописано в/,
    );
    assert.equal(writes[0].content, 'хвост');
  });
  it('без content → пустая строка', () => {
    const { deps, writes } = makeDeps();
    handleAppendFile(deps, { path: '/tmp/fs-test/a.md' });
    assert.equal(writes[0].content, '');
  });
  it('пустой path → подсказка; вне песочницы → ошибка', () => {
    assert.match(handleAppendFile(makeDeps().deps, { content: 'x' }), /Нужен непустой path/);
    assert.match(
      handleAppendFile(makeDeps().deps, { path: '/etc/x', content: 'y' }),
      /вне разрешённых/,
    );
  });
});

describe('handleListDir', () => {
  it('форматирует файлы и папки', () => {
    const { deps } = makeDeps({
      stat: () => 'dir',
      list: () => [
        { name: 'a.md', kind: 'file' },
        { name: 'sub', kind: 'dir' },
      ],
    });
    const result = handleListDir(deps, { path: '/tmp/fs-test' });
    assert.match(result, /📄 a\.md/);
    assert.match(result, /📁 sub/);
  });
  it('пустой каталог', () => {
    const { deps } = makeDeps({ stat: () => 'dir', list: () => [] });
    assert.match(handleListDir(deps, { path: '/tmp/fs-test' }), /пусто/);
  });
  it('не каталог → не найден', () => {
    const { deps } = makeDeps({ stat: () => 'file' });
    assert.match(handleListDir(deps, { path: '/tmp/fs-test/a.md' }), /Каталог не найден/);
  });
  it('без path — корень allow-list', () => {
    const { deps } = makeDeps({ stat: () => 'dir', list: () => [] });
    assert.match(handleListDir(deps, {}), /\/tmp\/fs-test: пусто/);
  });
  it('вне песочницы → ошибка', () => {
    assert.match(handleListDir(makeDeps().deps, { path: '/etc' }), /вне разрешённых/);
  });
});

describe('handleDeletePath', () => {
  it('удаляет файл', () => {
    const { deps, removed } = makeDeps({ stat: () => 'file' });
    assert.match(handleDeletePath(deps, { path: '/tmp/fs-test/a.md' }), /Удалён файл/);
    assert.deepEqual(removed, ['/tmp/fs-test/a.md']);
  });
  it('удаляет пустую папку', () => {
    const { deps, removed } = makeDeps({ stat: () => 'dir', list: () => [] });
    assert.match(handleDeletePath(deps, { path: '/tmp/fs-test/sub' }), /Удалён пустой каталог/);
    assert.deepEqual(removed, ['/tmp/fs-test/sub']);
  });
  it('непустая папка → отказ (без рекурсии)', () => {
    const { deps } = makeDeps({ stat: () => 'dir', list: () => [{ name: 'x', kind: 'file' }] });
    assert.match(handleDeletePath(deps, { path: '/tmp/fs-test/sub' }), /не пуст/);
  });
  it('корень allow-list удалить нельзя', () => {
    assert.match(
      handleDeletePath(makeDeps().deps, { path: '/tmp/fs-test' }),
      /корневой разрешённый/,
    );
  });
  it('не найдено → сообщение', () => {
    const { deps } = makeDeps({ stat: () => null });
    assert.match(handleDeletePath(deps, { path: '/tmp/fs-test/нет' }), /Путь не найден/);
  });
  it('пустой path → подсказка; вне песочницы → ошибка', () => {
    assert.match(handleDeletePath(makeDeps().deps, {}), /Нужен непустой path/);
    assert.match(handleDeletePath(makeDeps().deps, { path: '/etc/x' }), /вне разрешённых/);
  });
});
