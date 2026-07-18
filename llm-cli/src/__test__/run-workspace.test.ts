import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RunWorkspace,
  WorkspaceFileToolSet,
  WorkspaceCommandToolSet,
  createRunWorkspace,
  resolveInside,
  readProjectScripts,
  parseDotenv,
  loadProjectEnv,
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

  it('служебные каталоги (node_modules/.git) недоступны всем операциям', async () => {
    const { tools: set, io } = tools({
      '/w/worktree/node_modules/dep/index.js': 'бандл',
      '/w/worktree/.git/config': 'cfg',
    });
    assert.match(await set.call('read_file', { path: 'node_modules/dep/index.js' }), /служебный каталог/);
    assert.match(await set.call('list_dir', { path: 'node_modules' }), /служебный каталог/);
    assert.match(await set.call('grep', { pattern: 'x', path: '.git' }), /служебный каталог/);
    assert.match(await set.call('write_file', { path: 'node_modules/x', content: 'y' }), /служебный каталог/);
    assert.equal(io.files.has('/w/worktree/node_modules/x'), false); // запись не прошла
  });

  it('неизвестный инструмент → сообщение', async () => {
    const { tools: set } = tools();
    assert.match(await set.call('unknown_tool', {}), /Неизвестный инструмент/);
  });
});

describe('readProjectScripts', () => {
  it('нет package.json → пусто', () => {
    assert.deepEqual(readProjectScripts(new FakeIo(), '/p'), {});
  });
  it('валидные строковые скрипты (нестроковые отброшены)', () => {
    const io = new FakeIo({
      '/p/package.json': JSON.stringify({ scripts: { test: 'jest', build: 'tsc', bad: 5 } }),
    });
    assert.deepEqual(readProjectScripts(io, '/p'), { test: 'jest', build: 'tsc' });
  });
  it('scripts отсутствует / null / не объект → пусто', () => {
    assert.deepEqual(readProjectScripts(new FakeIo({ '/p/package.json': '{"name":"x"}' }), '/p'), {});
    assert.deepEqual(readProjectScripts(new FakeIo({ '/p/package.json': '{"scripts":null}' }), '/p'), {});
    assert.deepEqual(readProjectScripts(new FakeIo({ '/p/package.json': '{"scripts":"нет"}' }), '/p'), {});
  });
  it('битый package.json → пусто', () => {
    assert.deepEqual(readProjectScripts(new FakeIo({ '/p/package.json': '{не json' }), '/p'), {});
  });
});

describe('parseDotenv', () => {
  it('пары, кавычки, export; пропуск комментариев/пустых/без-=/пустого-ключа/незакрытых кавычек', () => {
    const env = parseDotenv(
      [
        '# комментарий',
        '',
        'export FOO=bar',
        'QUOTED="в кавычках"',
        "SINGLE='одинарные'",
        'PLAIN=значение',
        'SHORT=x', // однобуквенное — кавычки не снимаются (length<2)
        'BAD="незакрыто', // открытая кавычка без пары — не снимается
        'без_равно',
        '=пустой_ключ',
        '  SPACED  =  y  ',
      ].join('\n'),
    );
    assert.deepEqual(env, {
      FOO: 'bar',
      QUOTED: 'в кавычках',
      SINGLE: 'одинарные',
      PLAIN: 'значение',
      SHORT: 'x',
      BAD: '"незакрыто',
      SPACED: 'y',
    });
  });
});

describe('loadProjectEnv', () => {
  it('.env.development перекрывает .env; нет файлов → пусто; нечитаемый пропускается', () => {
    assert.deepEqual(loadProjectEnv(new FakeIo(), '/p'), {}); // файлов нет

    const io = new FakeIo({ '/p/.env': 'A=base\nB=base', '/p/.env.development': 'B=dev\nC=dev' });
    assert.deepEqual(loadProjectEnv(io, '/p'), { A: 'base', B: 'dev', C: 'dev' }); // dev перекрыл B

    const broken = new FakeIo({ '/p/.env': 'X=1' });
    broken.unreadable.add('/p/.env');
    assert.deepEqual(loadProjectEnv(broken, '/p'), {}); // чтение бросило → пропуск
  });

  it('дефолтный набор покрывает частые dev-конвенции (.env.dev / .local), более специфичный побеждает', () => {
    const io = new FakeIo({
      '/p/.env': 'V=base',
      '/p/.env.dev': 'V=dev',
      '/p/.env.development.local': 'V=local',
    });
    assert.equal(loadProjectEnv(io, '/p').V, 'local'); // .local идёт позже → перекрывает
  });

  it('оверрайд списка файлов: грузятся только указанные', () => {
    const io = new FakeIo({ '/p/.env': 'A=1', '/p/custom.env': 'B=2' });
    assert.deepEqual(loadProjectEnv(io, '/p', ['custom.env']), { B: '2' }); // .env НЕ грузится
  });
});

describe('WorkspaceCommandToolSet', () => {
  function cmd(
    scripts: Record<string, string>,
    calls?: { command: string; cwd: string; timeoutMs?: number }[],
    timeoutMs: number | undefined = 1000,
  ) {
    return new WorkspaceCommandToolSet('/w/worktree', 'npm', scripts, fakeRunner([], calls), timeoutMs);
  }

  it('allowedScripts: пропускает проверочные/фиксящие, режет деплой/lifecycle и прочее', () => {
    const set = cmd({
      test: 'jest',
      'prettier:write': 'prettier -w',
      lint: 'eslint',
      'lint:fix': 'eslint --fix',
      deploy: 'x',
      start: 'x',
      foo: 'x', // не проверочный/фиксящий — тоже не пускаем
    });
    assert.deepEqual(set.allowedScripts().sort(), ['lint', 'lint:fix', 'prettier:write', 'test']);
  });

  it('specs: run_command перечисляет доступные скрипты', () => {
    const specs = cmd({ format: 'prettier -w' }).specs();
    assert.equal(specs[0].name, 'run_command');
    assert.match(specs[0].description, /format/);
  });

  it('запускает разрешённый скрипт как <pm> run <script> в копии', async () => {
    const calls: { command: string; cwd: string; timeoutMs?: number }[] = [];
    const out = await cmd({ format: 'prettier -w' }, calls).call('run_command', { script: 'format' });
    assert.deepEqual(calls[0], { command: 'npm run format', cwd: '/w/worktree', timeoutMs: 1000 });
    assert.match(out, /format: код 0/);
  });

  it('код и хвост вывода в ответе; таймаут помечается (timeoutMs не задан)', async () => {
    const runner = fakeRunner([
      { match: () => true, result: { code: 2, stderr: 'ошибка сборки', timedOut: true } },
    ]);
    const set = new WorkspaceCommandToolSet('/w/worktree', 'npm', { build: 'tsc' }, runner, undefined);
    const out = await set.call('run_command', { script: 'build' });
    assert.match(out, /build: код 2 \(таймаут\)/);
    assert.match(out, /ошибка сборки/);
  });

  it('длинный вывод усечён', async () => {
    const runner = fakeRunner([{ match: () => true, result: { code: 1, stdout: 'ш'.repeat(3000) } }]);
    const set = new WorkspaceCommandToolSet('/w/worktree', 'npm', { test: 'jest' }, runner, 1000);
    assert.ok((await set.call('run_command', { script: 'test' })).includes('…'));
  });

  it('недоступный скрипт (неизвестный / опасный / пустой) → отказ', async () => {
    const set = cmd({ test: 'jest', deploy: 'x' });
    assert.match(await set.call('run_command', { script: 'нетакого' }), /недоступен/);
    assert.match(await set.call('run_command', { script: 'deploy' }), /недоступен/);
    assert.match(await set.call('run_command', { script: '' }), /недоступен/);
    // Совсем нет доступных скриптов → список «нет».
    assert.match(await cmd({ deploy: 'x' }).call('run_command', { script: 'deploy' }), /Доступны: нет/);
  });

  it('неизвестный инструмент → сообщение', async () => {
    assert.match(await cmd({}).call('other', {}), /Неизвестный инструмент/);
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

  it('run и run_command подмешивают переменные .env проекта', async () => {
    let sawRun: Record<string, string> | undefined;
    let sawCmd: Record<string, string> | undefined;
    const runner: ProjectCommandRunner = {
      run: async (command, options) => {
        if (command.includes('run format')) {
          sawCmd = options.env;
        } else {
          sawRun = options.env;
        }
        return { command, code: 0, stdout: '', stderr: '', timedOut: false };
      },
    };
    const workspace = new RunWorkspace(
      PROJECT,
      '/w/worktree',
      '/w',
      new FakeIo(),
      runner,
      1000,
      { format: 'prettier -w' },
      { BUILD_PUBLIC_BASE: '/app' },
    );
    await workspace.run('npm run build:main'); // команда проверки
    await workspace.tools.call('run_command', { script: 'format' }); // команда исполнителя
    assert.deepEqual(sawRun, { BUILD_PUBLIC_BASE: '/app' });
    assert.deepEqual(sawCmd, { BUILD_PUBLIC_BASE: '/app' });
  });

  it('run_command исполнителя использует packageManager проекта', async () => {
    const calls: { command: string; cwd: string; timeoutMs?: number }[] = [];
    const project = { ...PROJECT, packageManager: 'pnpm' };
    const workspace = new RunWorkspace(project, '/w/worktree', '/w', new FakeIo(), fakeRunner([], calls), 1000, {
      format: 'prettier -w',
    });
    await workspace.tools.call('run_command', { script: 'format' });
    assert.ok(calls.some(entry => entry.command === 'pnpm run format'));
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

  it('со скриптами проекта: исполнителю доступен run_command вместе с файловыми', async () => {
    const io = new FakeIo({
      '/tmp/ws/worktree/package.json': JSON.stringify({ scripts: { format: 'prettier -w' } }),
    });
    const workspace = await createRunWorkspace(PROJECT, io, fakeRunner([{ match: c => c.includes('worktree add') }]));
    const names = workspace.tools.specs().map(spec => spec.name);
    assert.ok(names.includes('run_command'));
    assert.ok(names.includes('write_file')); // файловые инструменты тоже на месте
  });

  it('без безопасных скриптов — только файловые инструменты (run_command не добавляется)', async () => {
    const io = new FakeIo({
      '/tmp/ws/worktree/package.json': JSON.stringify({ scripts: { deploy: 'x' } }),
    });
    const workspace = await createRunWorkspace(PROJECT, io, fakeRunner([{ match: c => c.includes('worktree add') }]));
    assert.ok(!workspace.tools.specs().some(spec => spec.name === 'run_command'));
  });

  it('загружает .env.development копии в команды проверки', async () => {
    const io = new FakeIo({ '/tmp/ws/worktree/.env.development': 'BUILD_PUBLIC_BASE=/app' });
    let sawEnv: Record<string, string> | undefined;
    const runner: ProjectCommandRunner = {
      run: async (command, options) => {
        if (command === 'npm run build') {
          sawEnv = options.env;
        }
        return { command, code: 0, stdout: '', stderr: '', timedOut: false };
      },
    };
    const workspace = await createRunWorkspace(PROJECT, io, runner);
    await workspace.run('npm run build');
    assert.deepEqual(sawEnv, { BUILD_PUBLIC_BASE: '/app' });
  });

  it('оверрайд envFiles: грузит нестандартный файл окружения', async () => {
    const io = new FakeIo({ '/tmp/ws/worktree/.env.custom': 'BUILD_PUBLIC_BASE=/custom' });
    let sawEnv: Record<string, string> | undefined;
    const runner: ProjectCommandRunner = {
      run: async (command, options) => {
        if (command === 'npm run build') {
          sawEnv = options.env;
        }
        return { command, code: 0, stdout: '', stderr: '', timedOut: false };
      },
    };
    const workspace = await createRunWorkspace(PROJECT, io, runner, { envFiles: ['.env.custom'] });
    await workspace.run('npm run build');
    assert.deepEqual(sawEnv, { BUILD_PUBLIC_BASE: '/custom' });
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
