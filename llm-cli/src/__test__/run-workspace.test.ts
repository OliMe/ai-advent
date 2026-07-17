import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RunWorkspace,
  WorkspaceFileToolSet,
  createRunWorkspace,
  resolveInside,
} from '../run-workspace.ts';
import type { WorkspaceIo } from '../run-workspace.ts';
import type {
  ProjectContext,
  ProjectCommandRunner,
  CommandResult,
} from '../../../core/src/index.ts';

/** In-memory файловый IO пространства: пути — ключи; каталог существует, если под ним есть файлы. */
class FakeIo implements WorkspaceIo {
  files = new Map<string, string>();
  unreadable = new Set<string>();
  symlinks: [string, string][] = [];
  removedDirs: string[] = [];
  tempPath: string;

  constructor(seed: Record<string, string> = {}, tempPath = '/tmp/ws') {
    this.tempPath = tempPath;
    for (const [path, content] of Object.entries(seed)) {
      this.files.set(path, content);
    }
  }
  private childrenUnder(path: string): boolean {
    const prefix = `${path}/`;
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }
  readFile(path: string): string {
    if (this.unreadable.has(path)) {
      throw new Error(`нечитаемый: ${path}`);
    }
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT ${path}`);
    }
    return content;
  }
  writeFile(path: string, content: string): void {
    this.files.set(path, content);
  }
  exists(path: string): boolean {
    return this.files.has(path) || this.childrenUnder(path);
  }
  isDirectory(path: string): boolean {
    return !this.files.has(path) && this.childrenUnder(path);
  }
  listDir(path: string): string[] {
    const prefix = `${path}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        names.add(key.slice(prefix.length).split('/')[0]);
      }
    }
    return [...names];
  }
  deleteFile(path: string): void {
    this.files.delete(path);
  }
  copyFile(source: string, destination: string): void {
    const content = this.files.get(source);
    if (content === undefined) {
      throw new Error(`copy ENOENT ${source}`);
    }
    this.files.set(destination, content);
  }
  symlink(target: string, linkPath: string): void {
    this.symlinks.push([target, linkPath]);
  }
  makeTempDir(): string {
    return this.tempPath;
  }
  removeDir(path: string): void {
    this.removedDirs.push(path);
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(path)) {
        this.files.delete(key);
      }
    }
  }
}

/** Фейковый запуск команд: результат по первому подходящему матчеру; фиксирует вызовы. */
function fakeRunner(
  handlers: { match: (command: string) => boolean; result?: Partial<CommandResult> }[],
  calls?: { command: string; cwd: string; timeoutMs?: number }[],
): ProjectCommandRunner {
  return {
    run: async (command, options) => {
      calls?.push({ command, cwd: options.cwd, timeoutMs: options.timeoutMs });
      const handler = handlers.find(entry => entry.match(command));
      const result = handler?.result ?? {};
      return {
        command,
        code: result.code ?? 0,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        timedOut: result.timedOut ?? false,
      };
    },
  };
}

const PROJECT: ProjectContext = {
  root: '/proj',
  name: 'proj',
  docSources: [],
  commands: { test: 'npm test' },
};

/** Пространство с корнем копии /w/worktree (методы changeSummary/apply/dispose/run/tools). */
function workspaceWith(
  io: FakeIo,
  runner: ProjectCommandRunner,
  timeoutMs: number | undefined,
): RunWorkspace {
  return new RunWorkspace(PROJECT, '/w/worktree', '/w', io, runner, timeoutMs);
}

describe('resolveInside', () => {
  it('путь внутри → абсолютный, наружу/абсолютный → null', () => {
    assert.equal(resolveInside('/w/worktree', 'README.md'), '/w/worktree/README.md');
    assert.equal(resolveInside('/w/worktree', '.'), '/w/worktree'); // сам корень
    assert.equal(resolveInside('/w/worktree', '../secret'), null);
    assert.equal(resolveInside('/w/worktree', '/etc/passwd'), null);
  });
});

describe('WorkspaceFileToolSet', () => {
  function tools(seed: Record<string, string> = {}, io = new FakeIo(seed)) {
    return { tools: new WorkspaceFileToolSet('/w/worktree', io), io };
  }

  it('specs: четыре инструмента с именами', () => {
    const { tools: set } = tools();
    assert.deepEqual(
      set.specs().map(spec => spec.name),
      ['read_file', 'write_file', 'list_dir', 'grep'],
    );
  });

  it('read_file: содержимое, отсутствие, путь наружу, пустой путь, усечение', async () => {
    const { tools: set } = tools({
      '/w/worktree/README.md': 'привет',
      '/w/worktree/big.txt': 'x'.repeat(20001),
    });
    assert.equal(await set.call('read_file', { path: 'README.md' }), 'привет');
    assert.match(await set.call('read_file', { path: 'missing.md' }), /Файл не найден/);
    assert.match(await set.call('read_file', { path: '../x' }), /путь вне проекта/);
    assert.match(await set.call('read_file', { path: '' }), /не указан путь/);
    assert.match(await set.call('read_file', { path: 'big.txt' }), /файл усечён/);
  });

  it('write_file: пишет в копию и отвергает путь наружу', async () => {
    const { tools: set, io } = tools();
    assert.match(await set.call('write_file', { path: 'docs/a.md', content: 'текст' }), /записан/);
    assert.equal(io.files.get('/w/worktree/docs/a.md'), 'текст');
    assert.match(await set.call('write_file', { path: '../evil', content: 'x' }), /вне проекта/);
  });

  it('list_dir: имена (без служебных), корень по умолчанию, не-каталог, пусто', async () => {
    const { tools: set } = tools({
      '/w/worktree/README.md': 'r',
      '/w/worktree/src/a.ts': 'a',
      '/w/worktree/node_modules/dep/x': 'd',
      '/w/worktree/empty/.git': 'g',
    });
    const rootList = await set.call('list_dir', {});
    assert.match(rootList, /README\.md/);
    assert.match(rootList, /src/);
    assert.doesNotMatch(rootList, /node_modules/); // служебный отфильтрован
    assert.equal(await set.call('list_dir', { path: 'README.md' }), 'Не каталог: README.md');
    assert.equal(await set.call('list_dir', { path: 'empty' }), '(пусто)'); // только .git
    assert.match(await set.call('list_dir', { path: '../..' }), /вне проекта/); // путь наружу
  });

  it('grep по дереву: заходит в подкаталоги, пропускает служебные', async () => {
    const io = new FakeIo({
      '/w/worktree/top.txt': 'foo здесь',
      '/w/worktree/sub/nested.txt': 'и тут foo',
      '/w/worktree/node_modules/dep/x.js': 'foo в зависимостях',
    });
    const set = new WorkspaceFileToolSet('/w/worktree', io);
    const out = await set.call('grep', { pattern: 'foo' });
    assert.match(out, /top\.txt:1/);
    assert.match(out, /sub\/nested\.txt:1/); // зашли в подкаталог (рекурсия)
    assert.doesNotMatch(out, /node_modules/); // служебный каталог пропущен
  });

  it('grep: совпадения, нет подстроки, не-каталог, нет совпадений, пропуск нечитаемого, лимит', async () => {
    const io = new FakeIo({
      '/w/worktree/a.ts': 'import foo\nconst x = 1\nfoo()',
      '/w/worktree/bin.dat': 'двоичное',
      '/w/worktree/many.txt': Array.from({ length: 150 }, () => 'foo').join('\n'),
    });
    io.unreadable.add('/w/worktree/bin.dat'); // чтение бросит → пропуск
    const { tools: set } = tools({}, io);
    const found = await set.call('grep', { pattern: 'foo', path: 'a.ts' }); // grep по одному файлу
    assert.match(found, /a\.ts:1: import foo/);
    assert.match(found, /a\.ts:3: foo\(\)/);
    assert.equal(await set.call('grep', { pattern: '' }), 'Ошибка: не указана подстрока поиска.');
    assert.equal(await set.call('grep', { pattern: 'foo', path: 'нет' }), 'Путь не найден: нет');
    assert.match(await set.call('grep', { pattern: 'неттакого', path: 'a.ts' }), /не найдено/);
    // Каталог со всеми файлами: нечитаемый bin.dat пропущен, лимит совпадений сработал.
    const capped = await set.call('grep', { pattern: 'foo' });
    assert.match(capped, /показаны первые 100/);
    assert.match(capped, /many\.txt|a\.ts/); // реальные совпадения присутствуют
  });

  it('grep: путь наружу отвергается', async () => {
    const { tools: set } = tools({ '/w/worktree/a.ts': 'foo' });
    assert.match(await set.call('grep', { pattern: 'foo', path: '../..' }), /вне проекта/);
  });

  it('неизвестный инструмент → сообщение', async () => {
    const { tools: set } = tools();
    assert.match(await set.call('unknown_tool', {}), /Неизвестный инструмент/);
  });
});

describe('RunWorkspace', () => {
  const NAME_STATUS = 'A\tnew.md\nM\tmod.ts\nD\told.txt\n\nbad\n';

  it('changeSummary: ставит правки, парсит A/M/D, отдаёт diff и файлы', async () => {
    const calls: { command: string; cwd: string }[] = [];
    const runner = fakeRunner(
      [
        { match: c => c.includes('--name-status'), result: { stdout: NAME_STATUS } },
        { match: c => c.includes('diff --cached'), result: { stdout: 'DIFF-ТЕКСТ' } },
      ],
      calls,
    );
    const summary = await workspaceWith(new FakeIo(), runner, 1000).changeSummary();
    assert.deepEqual(summary.files, ['new.md', 'mod.ts', 'old.txt']); // строка «bad» без пути отброшена
    assert.equal(summary.diff, 'DIFF-ТЕКСТ');
    assert.ok(calls.some(entry => entry.command.includes('add -A') && entry.cwd === '/w/worktree'));
  });

  it('apply: A/M копирует, D удаляет; возвращает пути', async () => {
    const io = new FakeIo({
      '/w/worktree/new.md': 'новое',
      '/w/worktree/mod.ts': 'изменено',
      '/proj/old.txt': 'на удаление',
    });
    const runner = fakeRunner([
      { match: c => c.includes('--name-status'), result: { stdout: NAME_STATUS } },
    ]);
    const applied = await workspaceWith(io, runner, undefined).apply(); // timeoutMs undefined
    assert.deepEqual(applied, ['new.md', 'mod.ts', 'old.txt']);
    assert.equal(io.files.get('/proj/new.md'), 'новое'); // A скопирован
    assert.equal(io.files.get('/proj/mod.ts'), 'изменено'); // M скопирован
    assert.equal(io.files.has('/proj/old.txt'), false); // D удалён
  });

  it('run: команда проекта идёт в cwd копии (с таймаутом и без)', async () => {
    const calls: { command: string; cwd: string; timeoutMs?: number }[] = [];
    const runner = fakeRunner([], calls);
    await workspaceWith(new FakeIo(), runner, 5000).run('npm test');
    await workspaceWith(new FakeIo(), runner, undefined).run('npm run build');
    assert.deepEqual(calls[0], { command: 'npm test', cwd: '/w/worktree', timeoutMs: 5000 });
    assert.deepEqual(calls[1], { command: 'npm run build', cwd: '/w/worktree', timeoutMs: undefined });
  });

  it('dispose: удаляет worktree и временный каталог', async () => {
    const calls: { command: string; cwd: string }[] = [];
    const io = new FakeIo();
    const runner = fakeRunner([], calls);
    await workspaceWith(io, runner, 1000).dispose();
    assert.ok(calls.some(entry => entry.command.includes('worktree remove --force')));
    assert.deepEqual(io.removedDirs, ['/w']);
  });

  it('dispose: сбой очистки временного каталога не бросает', async () => {
    const io = new FakeIo();
    io.removeDir = () => {
      throw new Error('busy');
    };
    await workspaceWith(io, fakeRunner([]), 1000).dispose(); // не должно бросить
  });
});

describe('createRunWorkspace', () => {
  it('создаёт worktree и пробрасывает node_modules симлинком', async () => {
    const io = new FakeIo({ '/proj/node_modules/dep/index.js': 'x' });
    const calls: { command: string; cwd: string }[] = [];
    const runner = fakeRunner([{ match: c => c.includes('worktree add') }], calls);
    const workspace = await createRunWorkspace(PROJECT, io, runner, { timeoutMs: 1000 });
    assert.ok(workspace instanceof RunWorkspace);
    assert.ok(calls[0].command.includes('worktree add --detach /tmp/ws/worktree HEAD'));
    assert.deepEqual(io.symlinks, [['/proj/node_modules', '/tmp/ws/worktree/node_modules']]);
  });

  it('без node_modules — симлинк не создаётся (timeoutMs не задан)', async () => {
    const io = new FakeIo();
    const runner = fakeRunner([{ match: c => c.includes('worktree add') }]);
    await createRunWorkspace(PROJECT, io, runner);
    assert.deepEqual(io.symlinks, []);
  });

  it('путь копии с пробелом — экранируется кавычками', async () => {
    const io = new FakeIo({}, '/tmp/ws dir');
    const calls: { command: string; cwd: string }[] = [];
    const runner = fakeRunner([{ match: c => c.includes('worktree add') }], calls);
    await createRunWorkspace(PROJECT, io, runner);
    assert.match(calls[0].command, /"\/tmp\/ws dir\/worktree"/);
  });

  it('сбой git worktree → чистит временный каталог и бросает (stderr)', async () => {
    const io = new FakeIo();
    const runner = fakeRunner([{ match: c => c.includes('worktree add'), result: { code: 1, stderr: 'boom' } }]);
    await assert.rejects(createRunWorkspace(PROJECT, io, runner), /git worktree.*boom/s);
    assert.deepEqual(io.removedDirs, ['/tmp/ws']);
  });

  it('сбой git worktree без stderr → берёт stdout', async () => {
    const io = new FakeIo();
    const runner = fakeRunner([{ match: c => c.includes('worktree add'), result: { code: 1, stdout: 'из stdout' } }]);
    await assert.rejects(createRunWorkspace(PROJECT, io, runner), /из stdout/);
  });
});
