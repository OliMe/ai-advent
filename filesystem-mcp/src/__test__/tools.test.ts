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

/** Фейковый IO с настраиваемыми stat/list/read и записью мутаций; опц. confirm для путей вне песочницы. */
function makeDeps(
  overrides: Partial<FsIo> = {},
  confirm?: ToolDeps['confirm'],
): {
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
  return { deps: { io, allowedDirs: ALLOWED, ...(confirm ? { confirm } : {}) }, writes, removed };
}

describe('handleReadFile', () => {
  it('читает существующий файл', async () => {
    const { deps } = makeDeps({ stat: () => 'file', read: () => 'привет' });
    assert.equal(await handleReadFile(deps, { path: '/tmp/fs-test/a.md' }), 'привет');
  });
  it('не файл → не найден', async () => {
    const { deps } = makeDeps({ stat: () => null });
    assert.match(await handleReadFile(deps, { path: '/tmp/fs-test/a.md' }), /Файл не найден/);
  });
  it('пустой path → подсказка', async () => {
    assert.match(await handleReadFile(makeDeps().deps, {}), /Нужен непустой path/);
  });
  it('путь вне песочницы без подтверждения → отказ', async () => {
    assert.match(await handleReadFile(makeDeps().deps, { path: '/etc/passwd' }), /вне разрешённых/);
  });
  it('ошибка не-Error приводится к строке', async () => {
    const { deps } = makeDeps({
      stat: () => 'file',
      read: () => {
        throw 'строковый сбой';
      },
    });
    assert.equal(await handleReadFile(deps, { path: '/tmp/fs-test/a.md' }), 'строковый сбой');
  });
});

describe('handleWriteFile', () => {
  it('пишет файл и подтверждает', async () => {
    const { deps, writes } = makeDeps();
    const result = await handleWriteFile(deps, { path: '/tmp/fs-test/a.md', content: 'abc' });
    assert.match(result, /Записано: \/tmp\/fs-test\/a\.md \(3 символов\)/);
    assert.deepEqual(writes, [{ path: '/tmp/fs-test/a.md', content: 'abc' }]);
  });
  it('без content → пустая строка (0 символов)', async () => {
    const { deps } = makeDeps();
    assert.match(await handleWriteFile(deps, { path: '/tmp/fs-test/a.md' }), /\(0 символов\)/);
  });
  it('ошибка IO при записи → текст', async () => {
    const { deps } = makeDeps({
      write: () => {
        throw new Error('только чтение');
      },
    });
    assert.match(
      await handleWriteFile(deps, { path: '/tmp/fs-test/a.md', content: 'x' }),
      /только чтение/,
    );
  });
  it('пустой path → подсказка; вне песочницы без подтверждения → отказ', async () => {
    assert.match(await handleWriteFile(makeDeps().deps, {}), /Нужен непустой path/);
    assert.match(
      await handleWriteFile(makeDeps().deps, { path: '/etc/x', content: 'y' }),
      /вне разрешённых/,
    );
  });
});

describe('подтверждение пути вне песочницы (elicitation)', () => {
  it('confirm=accept → операция вне песочницы выполняется', async () => {
    const { deps, writes } = makeDeps({}, async () => true);
    const result = await handleWriteFile(deps, { path: '/etc/x', content: 'y' });
    assert.match(result, /Записано: \/etc\/x/);
    assert.deepEqual(writes, [{ path: '/etc/x', content: 'y' }]);
  });
  it('confirm=decline → отказ пользователем, запись не выполняется', async () => {
    const { deps, writes } = makeDeps({}, async () => false);
    const result = await handleWriteFile(deps, { path: '/etc/x', content: 'y' });
    assert.match(result, /отклонена пользователем/);
    assert.deepEqual(writes, []);
  });
  it('confirm получает сообщение с абсолютным путём', async () => {
    let seen = '';
    const { deps } = makeDeps({}, async message => {
      seen = message;
      return false;
    });
    await handleReadFile(deps, { path: '/etc/passwd' });
    assert.match(seen, /\/etc\/passwd/);
    assert.match(seen, /вне разрешённых каталогов/);
  });
});

describe('handleAppendFile', () => {
  it('дописывает и подтверждает', async () => {
    const { deps, writes } = makeDeps();
    assert.match(
      await handleAppendFile(deps, { path: '/tmp/fs-test/a.md', content: 'хвост' }),
      /Дописано в/,
    );
    assert.equal(writes[0].content, 'хвост');
  });
  it('без content → пустая строка', async () => {
    const { deps, writes } = makeDeps();
    await handleAppendFile(deps, { path: '/tmp/fs-test/a.md' });
    assert.equal(writes[0].content, '');
  });
  it('пустой path → подсказка; вне песочницы → отказ; ошибка IO → текст', async () => {
    assert.match(await handleAppendFile(makeDeps().deps, { content: 'x' }), /Нужен непустой path/);
    assert.match(
      await handleAppendFile(makeDeps().deps, { path: '/etc/x', content: 'y' }),
      /вне разрешённых/,
    );
    const { deps } = makeDeps({
      append: () => {
        throw new Error('диск полон');
      },
    });
    assert.match(
      await handleAppendFile(deps, { path: '/tmp/fs-test/a.md', content: 'z' }),
      /диск полон/,
    );
  });
});

describe('handleListDir', () => {
  it('форматирует файлы и папки', async () => {
    const { deps } = makeDeps({
      stat: () => 'dir',
      list: () => [
        { name: 'a.md', kind: 'file' },
        { name: 'sub', kind: 'dir' },
      ],
    });
    const result = await handleListDir(deps, { path: '/tmp/fs-test' });
    assert.match(result, /📄 a\.md/);
    assert.match(result, /📁 sub/);
  });
  it('пустой каталог', async () => {
    const { deps } = makeDeps({ stat: () => 'dir', list: () => [] });
    assert.match(await handleListDir(deps, { path: '/tmp/fs-test' }), /пусто/);
  });
  it('не каталог → не найден', async () => {
    const { deps } = makeDeps({ stat: () => 'file' });
    assert.match(await handleListDir(deps, { path: '/tmp/fs-test/a.md' }), /Каталог не найден/);
  });
  it('без path — корень allow-list', async () => {
    const { deps } = makeDeps({ stat: () => 'dir', list: () => [] });
    assert.match(await handleListDir(deps, {}), /\/tmp\/fs-test: пусто/);
  });
  it('вне песочницы без подтверждения → отказ', async () => {
    assert.match(await handleListDir(makeDeps().deps, { path: '/etc' }), /вне разрешённых/);
  });
  it('ошибка IO при листинге → текст', async () => {
    const { deps } = makeDeps({
      stat: () => 'dir',
      list: () => {
        throw new Error('нет доступа');
      },
    });
    assert.match(await handleListDir(deps, { path: '/tmp/fs-test' }), /нет доступа/);
  });
});

describe('handleDeletePath', () => {
  it('удаляет файл', async () => {
    const { deps, removed } = makeDeps({ stat: () => 'file' });
    assert.match(await handleDeletePath(deps, { path: '/tmp/fs-test/a.md' }), /Удалён файл/);
    assert.deepEqual(removed, ['/tmp/fs-test/a.md']);
  });
  it('удаляет пустую папку', async () => {
    const { deps, removed } = makeDeps({ stat: () => 'dir', list: () => [] });
    assert.match(
      await handleDeletePath(deps, { path: '/tmp/fs-test/sub' }),
      /Удалён пустой каталог/,
    );
    assert.deepEqual(removed, ['/tmp/fs-test/sub']);
  });
  it('непустая папка → отказ (без рекурсии)', async () => {
    const { deps } = makeDeps({ stat: () => 'dir', list: () => [{ name: 'x', kind: 'file' }] });
    assert.match(await handleDeletePath(deps, { path: '/tmp/fs-test/sub' }), /не пуст/);
  });
  it('корень allow-list удалить нельзя', async () => {
    assert.match(
      await handleDeletePath(makeDeps().deps, { path: '/tmp/fs-test' }),
      /корневой разрешённый/,
    );
  });
  it('не найдено → сообщение', async () => {
    const { deps } = makeDeps({ stat: () => null });
    assert.match(await handleDeletePath(deps, { path: '/tmp/fs-test/нет' }), /Путь не найден/);
  });
  it('ошибка IO при удалении → текст', async () => {
    const { deps } = makeDeps({
      stat: () => 'file',
      removeFile: () => {
        throw new Error('занято');
      },
    });
    assert.match(await handleDeletePath(deps, { path: '/tmp/fs-test/a.md' }), /занято/);
  });
  it('пустой path → подсказка; вне песочницы без подтверждения → отказ', async () => {
    assert.match(await handleDeletePath(makeDeps().deps, {}), /Нужен непустой path/);
    assert.match(await handleDeletePath(makeDeps().deps, { path: '/etc/x' }), /вне разрешённых/);
  });
});
