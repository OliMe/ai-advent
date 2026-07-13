import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  limitOutput,
  handleGitBranch,
  handleGitStatus,
  handleGitListFiles,
  handleGitLog,
  handleGitDiff,
  handleGitGrep,
  handleReadFile,
} from '../index.ts';
import type { GitIo, GitResult, ToolDeps } from '../index.ts';

const REPO = '/tmp/repo';

/** Ответ git-команды в тестовом сценарии. */
const ok = (output: string): GitResult => ({ output, ok: true });
const failed = (output: string): GitResult => ({ output, ok: false });

/** Сценарий git: по массиву аргументов возвращает ответ; `rev-parse` корня отвечает сам. */
type Script = (args: string[]) => GitResult;

interface FakeOptions {
  script?: Script;
  confirm?: (message: string) => Promise<boolean>;
  allowedRepos?: string[];
  maxOutputChars?: number;
  readText?: (path: string) => string;
  stat?: (path: string) => 'file' | 'dir' | null;
  commands?: string[][];
}

/** Зависимости обработчиков поверх фейкового git — без реального репозитория. */
function makeDeps(options: FakeOptions = {}): ToolDeps {
  const script: Script = options.script ?? (() => ok(''));
  const io: GitIo = {
    run: (args, cwd) => {
      options.commands?.push([...args, `cwd=${cwd}`]);
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return ok(`${REPO}\n`);
      }
      return script(args);
    },
    readText: options.readText ?? (() => 'содержимое'),
    stat: options.stat ?? (() => 'file'),
  };
  const deps: ToolDeps = {
    io,
    allowedRepos: options.allowedRepos ?? [REPO],
    maxOutputChars: options.maxOutputChars ?? 8000,
  };
  return options.confirm === undefined ? deps : { ...deps, confirm: options.confirm };
}

describe('limitOutput', () => {
  it('короткий вывод не трогает', () => {
    assert.equal(limitOutput('строка', 100), 'строка');
  });

  it('длинный усекает и честно помечает', () => {
    const limited = limitOutput('абвгде', 3);
    assert.match(limited, /^абв\n… \(вывод усечён: 6 символов, показано 3\)$/);
  });
});

describe('ворота доступа к репозиторию', () => {
  it('репозиторий по умолчанию — первый разрешённый', async () => {
    const commands: string[][] = [];
    const deps = makeDeps({ script: () => ok('main'), commands });
    await handleGitBranch(deps, {});
    assert.deepEqual(commands[0], ['rev-parse', '--show-toplevel', `cwd=${REPO}`]);
  });

  it('явный repo внутри allow-list принимается', async () => {
    const commands: string[][] = [];
    const deps = makeDeps({ script: () => ok('main'), commands });
    await handleGitBranch(deps, { repo: `${REPO}/src` });
    assert.deepEqual(commands[0], ['rev-parse', '--show-toplevel', `cwd=${REPO}/src`]);
  });

  it('репозиторий вне allow-list без подтверждения — отказ', async () => {
    const deps = makeDeps({});
    assert.match(await handleGitBranch(deps, { repo: '/etc/secret' }), /вне разрешённых/);
  });

  it('репозиторий вне allow-list с подтверждением — разрешён', async () => {
    const asked: string[] = [];
    const deps = makeDeps({
      script: () => ok('main'),
      confirm: async message => {
        asked.push(message);
        return true;
      },
    });
    const answer = await handleGitBranch(deps, { repo: '/tmp/other' });
    assert.match(answer, /Ветка: main/);
    assert.match(asked[0], /вне разрешённых каталогов/);
  });

  it('пользователь отклонил репозиторий вне allow-list — отказ', async () => {
    const deps = makeDeps({ confirm: async () => false });
    assert.match(await handleGitBranch(deps, { repo: '/tmp/other' }), /отклонено пользователем/);
  });

  it('каталог не является git-репозиторием — отказ', async () => {
    const io: GitIo = {
      run: () => failed('fatal: not a git repository'),
      readText: () => '',
      stat: () => 'file',
    };
    const deps: ToolDeps = { io, allowedRepos: [REPO], maxOutputChars: 8000 };
    assert.match(await handleGitStatus(deps, {}), /Не git-репозиторий/);
  });
});

describe('git_branch', () => {
  it('обычная ветка', async () => {
    const answer = await handleGitBranch(makeDeps({ script: () => ok('main\n') }), {});
    assert.match(answer, /Репозиторий: \/tmp\/repo/);
    assert.match(answer, /Ветка: main/);
  });

  it('отделённый HEAD показывает коммит', async () => {
    const script: Script = args => (args[1] === '--abbrev-ref' ? ok('HEAD\n') : ok('a1b2c3d\n'));
    const answer = await handleGitBranch(makeDeps({ script }), {});
    assert.match(answer, /HEAD отделён \(a1b2c3d\)/);
  });

  it('сбой git — текст ошибки', async () => {
    const answer = await handleGitBranch(makeDeps({ script: () => failed('fatal: сбой') }), {});
    assert.match(answer, /Ошибка git: fatal: сбой/);
  });
});

describe('git_status', () => {
  it('изменения показываются', async () => {
    const answer = await handleGitStatus(makeDeps({ script: () => ok(' M src/a.ts\n') }), {});
    assert.match(answer, /M src\/a\.ts/);
  });

  it('чистое дерево', async () => {
    assert.match(await handleGitStatus(makeDeps({ script: () => ok('') }), {}), /чисто/);
  });
});

describe('git_list_files', () => {
  it('без подкаталога — все файлы', async () => {
    const commands: string[][] = [];
    const deps = makeDeps({ script: () => ok('src/a.ts\nREADME.md'), commands });
    const answer = await handleGitListFiles(deps, {});
    assert.match(answer, /README\.md/);
    assert.deepEqual(commands[1], ['ls-files', `cwd=${REPO}`]);
  });

  it('подкаталог сужает выдачу', async () => {
    const commands: string[][] = [];
    const deps = makeDeps({ script: () => ok('src/a.ts'), commands });
    await handleGitListFiles(deps, { subdir: 'src' });
    assert.deepEqual(commands[1], ['ls-files', '--', `${REPO}/src`, `cwd=${REPO}`]);
  });

  it('подкаталог вне репозитория — отказ', async () => {
    const answer = await handleGitListFiles(makeDeps({}), { subdir: '../../etc' });
    assert.match(answer, /Путь вне репозитория/);
  });

  it('пустой репозиторий', async () => {
    const answer = await handleGitListFiles(makeDeps({ script: () => ok('') }), {});
    assert.match(answer, /Отслеживаемых файлов не найдено/);
  });

  it('отказ ворот пробрасывается', async () => {
    const answer = await handleGitListFiles(makeDeps({}), { repo: '/etc' });
    assert.match(answer, /вне разрешённых/);
  });
});

describe('git_log', () => {
  it('лимит по умолчанию — 10', async () => {
    const commands: string[][] = [];
    await handleGitLog(
      makeDeps({ script: () => ok('a1b2c3d 2026-07-13 vizgin — правка'), commands }),
      {},
    );
    assert.deepEqual(commands[1]?.slice(0, 3), ['log', '-n', '10']);
  });

  it('лимит из аргумента', async () => {
    const commands: string[][] = [];
    await handleGitLog(makeDeps({ script: () => ok('x'), commands }), { limit: 3 });
    assert.deepEqual(commands[1]?.slice(0, 3), ['log', '-n', '3']);
  });

  it('лимит зажат в границы', async () => {
    const commands: string[][] = [];
    const deps = makeDeps({ script: () => ok('x'), commands });
    await handleGitLog(deps, { limit: 999 });
    await handleGitLog(deps, { limit: 0 });
    assert.equal(commands[1]?.[2], '50');
    assert.equal(commands[3]?.[2], '1');
  });

  it('нечисловой лимит — дефолт; пустая история', async () => {
    const answer = await handleGitLog(makeDeps({ script: () => ok('') }), { limit: 'много' });
    assert.match(answer, /История пуста/);
  });

  it('отказ ворот пробрасывается', async () => {
    assert.match(await handleGitLog(makeDeps({}), { repo: '/etc' }), /вне разрешённых/);
  });
});

describe('git_diff', () => {
  it('рабочее дерево', async () => {
    const commands: string[][] = [];
    const deps = makeDeps({ script: () => ok('diff --git a/x b/x'), commands });
    assert.match(await handleGitDiff(deps, {}), /diff --git/);
    assert.deepEqual(commands[1], ['diff', `cwd=${REPO}`]);
  });

  it('staged добавляет --cached, path сужает до файла', async () => {
    const commands: string[][] = [];
    const deps = makeDeps({ script: () => ok('diff'), commands });
    await handleGitDiff(deps, { staged: true, path: 'src/a.ts' });
    assert.deepEqual(commands[1], ['diff', '--cached', '--', `${REPO}/src/a.ts`, `cwd=${REPO}`]);
  });

  it('путь вне репозитория — отказ', async () => {
    assert.match(await handleGitDiff(makeDeps({}), { path: '/etc/passwd' }), /вне репозитория/);
  });

  it('изменений нет', async () => {
    assert.match(await handleGitDiff(makeDeps({ script: () => ok('') }), {}), /Изменений нет/);
  });

  it('отказ ворот пробрасывается', async () => {
    assert.match(await handleGitDiff(makeDeps({}), { repo: '/etc' }), /вне разрешённых/);
  });

  it('длинный diff усекается', async () => {
    const deps = makeDeps({ script: () => ok('x'.repeat(50)), maxOutputChars: 10 });
    assert.match(await handleGitDiff(deps, {}), /вывод усечён/);
  });
});

describe('git_grep', () => {
  it('находит совпадения', async () => {
    const commands: string[][] = [];
    const deps = makeDeps({ script: () => ok('src/a.ts:10:const token = 1;'), commands });
    const answer = await handleGitGrep(deps, { pattern: 'token' });
    assert.match(answer, /src\/a\.ts:10/);
    assert.deepEqual(commands[1], ['grep', '-n', '-I', '--no-color', '-e', 'token', `cwd=${REPO}`]);
  });

  it('подкаталог сужает поиск', async () => {
    const commands: string[][] = [];
    const deps = makeDeps({ script: () => ok('src/a.ts:1:x'), commands });
    await handleGitGrep(deps, { pattern: 'x', subdir: 'src' });
    assert.equal(commands[1]?.at(-2), `${REPO}/src`);
  });

  it('нет совпадений (git вернул ненулевой код без текста)', async () => {
    const deps = makeDeps({ script: () => failed('') });
    assert.match(await handleGitGrep(deps, { pattern: 'нетуда' }), /Совпадений не найдено/);
  });

  it('ошибка git показывается', async () => {
    const deps = makeDeps({ script: () => failed('fatal: сбой') });
    assert.match(await handleGitGrep(deps, { pattern: 'x' }), /Ошибка git: fatal: сбой/);
  });

  it('без шаблона — подсказка', async () => {
    assert.match(await handleGitGrep(makeDeps({}), {}), /Нужен непустой pattern/);
  });

  it('подкаталог вне репозитория — отказ', async () => {
    const answer = await handleGitGrep(makeDeps({}), { pattern: 'x', subdir: '../..' });
    assert.match(answer, /вне репозитория/);
  });

  it('отказ ворот пробрасывается', async () => {
    const answer = await handleGitGrep(makeDeps({}), { pattern: 'x', repo: '/etc' });
    assert.match(answer, /вне разрешённых/);
  });
});

describe('read_file', () => {
  it('читает файл рабочего дерева', async () => {
    const read: string[] = [];
    const deps = makeDeps({
      readText: path => {
        read.push(path);
        return '# демо';
      },
    });
    assert.equal(await handleReadFile(deps, { path: 'README.md' }), '# демо');
    assert.deepEqual(read, [`${REPO}/README.md`]);
  });

  it('длинный файл усекается', async () => {
    const deps = makeDeps({ readText: () => 'я'.repeat(30), maxOutputChars: 5 });
    assert.match(await handleReadFile(deps, { path: 'big.txt' }), /вывод усечён/);
  });

  it('без пути — подсказка', async () => {
    assert.match(await handleReadFile(makeDeps({}), {}), /Нужен непустой path/);
  });

  it('путь вне репозитория — отказ', async () => {
    assert.match(await handleReadFile(makeDeps({}), { path: '/etc/passwd' }), /вне репозитория/);
  });

  it('каталог вместо файла — не найден', async () => {
    const deps = makeDeps({ stat: () => 'dir' });
    assert.match(await handleReadFile(deps, { path: 'src' }), /Файл не найден/);
  });

  it('ошибка чтения превращается в текст', async () => {
    const withError = makeDeps({
      readText: () => {
        throw new Error('нет доступа');
      },
    });
    assert.equal(await handleReadFile(withError, { path: 'a.ts' }), 'нет доступа');

    const withStringThrow = makeDeps({
      readText: () => {
        throw 'сломалось';
      },
    });
    assert.equal(await handleReadFile(withStringThrow, { path: 'a.ts' }), 'сломалось');
  });

  it('отказ ворот пробрасывается', async () => {
    const answer = await handleReadFile(makeDeps({}), { repo: '/etc', path: 'a.ts' });
    assert.match(answer, /вне разрешённых/);
  });
});
