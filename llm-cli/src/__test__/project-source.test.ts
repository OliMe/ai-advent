import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  isRepositoryUrl,
  projectsCacheDirectory,
  cloneTargetDirectory,
  resolveProjectRoot,
  realGitRunner,
} from '../index.ts';
import type { ProjectSourceDeps } from '../index.ts';

/** Зависимости привязки: запуск git пишется в журнал, существование путей задаётся набором. */
function makeDeps(
  present: string[],
  options: { fail?: string; commands?: string[][]; progress?: string[] } = {},
): ProjectSourceDeps {
  const existing = new Set(present);
  return {
    runner: (command, args) => {
      options.commands?.push([command, ...args]);
      if (options.fail !== undefined && args.includes(options.fail)) {
        throw new Error('git сломался');
      }
      return '';
    },
    exists: path => existing.has(path),
    ...(options.progress === undefined
      ? {}
      : { onProgress: (message: string) => options.progress?.push(message) }),
  };
}

describe('isRepositoryUrl', () => {
  it('распознаёт удалённые репозитории', () => {
    assert.ok(isRepositoryUrl('https://github.com/vizgin/ai-advent'));
    assert.ok(isRepositoryUrl('http://git.local/x'));
    assert.ok(isRepositoryUrl('git@github.com:vizgin/ai-advent.git'));
    assert.ok(isRepositoryUrl('ssh://git@host/x'));
    assert.ok(isRepositoryUrl('/зеркало/repo.git'));
  });

  it('локальный путь — не URL', () => {
    assert.equal(isRepositoryUrl('/Users/vizgin/projects/ai-advent'), false);
    assert.equal(isRepositoryUrl('~/projects/repo'), false);
    assert.equal(isRepositoryUrl('../соседний'), false);
  });
});

describe('cloneTargetDirectory', () => {
  it('внутри кэша, каталог-хэш + НАСТОЯЩЕЕ имя репозитория (им адресуют проект)', () => {
    const target = cloneTargetDirectory('https://github.com/vizgin/ai-advent.git');
    assert.ok(target.startsWith(projectsCacheDirectory()));
    assert.match(target, /\/[0-9a-f]{8}\/ai-advent$/);
  });

  it('одинаковые имена с разных хостов не сталкиваются', () => {
    const first = cloneTargetDirectory('https://github.com/a/repo.git');
    const second = cloneTargetDirectory('https://gitlab.com/b/repo.git');
    assert.notEqual(first, second);
  });

  it('один репозиторий в разной записи — один клон (хвостовой слэш, .git)', () => {
    const plain = cloneTargetDirectory('https://host/x/repo');
    assert.equal(cloneTargetDirectory('https://host/x/repo/'), plain);
    assert.equal(cloneTargetDirectory('https://host/x/repo.git'), plain);
  });

  it('имя не выводится — запасное «repo»', () => {
    assert.match(cloneTargetDirectory('.git'), /\/[0-9a-f]{8}\/repo$/);
  });

  it('кэш лежит в ~/.llm-cli/projects', () => {
    assert.equal(projectsCacheDirectory(), join(homedir(), '.llm-cli', 'projects'));
  });
});

describe('realGitRunner', () => {
  it('запускает настоящий git', () => {
    assert.match(realGitRunner('git', ['--version']), /git version/);
  });
});

describe('resolveProjectRoot: локальный путь', () => {
  it('существующий путь приводится к абсолютному', () => {
    assert.equal(resolveProjectRoot('/work/repo', makeDeps(['/work/repo'])), '/work/repo');
  });

  it('тильда разворачивается', () => {
    const path = join(homedir(), 'projects', 'repo');
    assert.equal(resolveProjectRoot('~/projects/repo', makeDeps([path])), path);
    assert.equal(resolveProjectRoot('~', makeDeps([homedir()])), homedir());
  });

  it('относительный путь — от текущего каталога', () => {
    const path = join(process.cwd(), 'src');
    assert.equal(resolveProjectRoot('src', makeDeps([path])), path);
  });

  it('нет каталога — внятная ошибка, привязки нет', () => {
    assert.throws(() => resolveProjectRoot('/нет', makeDeps([])), /Каталог не найден/);
  });
});

describe('resolveProjectRoot: удалённый репозиторий', () => {
  const url = 'https://github.com/vizgin/ai-advent.git';
  const target = cloneTargetDirectory(url);

  it('клонирует blobless-клоном (история сохранена — git log/diff рабочие)', () => {
    const commands: string[][] = [];
    const progress: string[] = [];
    assert.equal(resolveProjectRoot(url, makeDeps([], { commands, progress })), target);
    assert.deepEqual(commands, [['git', 'clone', '--filter=blob:none', url, target]]);
    assert.match(progress[0], /Клонирую/);
  });

  it('повторная привязка — fetch, а не новый клон', () => {
    const commands: string[][] = [];
    const progress: string[] = [];
    const deps = makeDeps([join(target, '.git')], { commands, progress });
    assert.equal(resolveProjectRoot(url, deps), target);
    assert.deepEqual(commands, [['git', '-C', target, 'fetch', '--prune']]);
    assert.match(progress[0], /уже склонирован/);
  });

  it('сбой обновления не мешает работать с уже склонированной копией', () => {
    const progress: string[] = [];
    const deps = makeDeps([join(target, '.git')], { fail: 'fetch', progress });
    assert.equal(resolveProjectRoot(url, deps), target);
    assert.match(progress[1], /Не удалось обновить клон/);
  });

  it('сбой клонирования — ошибка, привязки нет', () => {
    assert.throws(
      () => resolveProjectRoot(url, makeDeps([], { fail: 'clone' })),
      /Не удалось клонировать/,
    );
  });

  it('работает и без отчёта о прогрессе (тихий режим)', () => {
    const deps = makeDeps([join(target, '.git')], { fail: 'fetch' });
    assert.equal(resolveProjectRoot(url, deps), target);
  });

  it('git упал не-исключением — текст всё равно попадает в ошибку', () => {
    const deps: ProjectSourceDeps = {
      runner: () => {
        throw 'git отсутствует';
      },
      exists: () => false,
    };
    assert.throws(() => resolveProjectRoot(url, deps), /Не удалось клонировать.*git отсутствует/);
  });
});
