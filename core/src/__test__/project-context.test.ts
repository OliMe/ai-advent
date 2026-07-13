import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  nodeProjectIo,
  detectProjectRoot,
  discoverDocSources,
  detectPackageManager,
  detectProjectCommands,
  detectOrigin,
  loadProjectContext,
  formatProjectContext,
  formatWorkspace,
} from '../index.ts';
import type { ProjectIo, ProjectContext } from '../index.ts';

/** Проект как карта путей: 'dir' — каталог, строка — содержимое файла. */
function fakeIo(tree: Record<string, 'dir' | string>): ProjectIo {
  return {
    stat: path => {
      const entry = tree[path];
      if (entry === undefined) {
        return null;
      }
      return entry === 'dir' ? 'dir' : 'file';
    },
    list: path => {
      const prefix = `${path}/`;
      const names = Object.keys(tree)
        .filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
        .map(key => key.slice(prefix.length));
      if (names.length === 0 && tree[path] !== 'dir') {
        throw new Error(`нет каталога: ${path}`);
      }
      return names;
    },
    readText: path => {
      const entry = tree[path];
      if (entry === undefined || entry === 'dir') {
        throw new Error(`нет файла: ${path}`);
      }
      return entry;
    },
  };
}

describe('detectProjectRoot', () => {
  it('поднимается вверх до каталога с .git', () => {
    const io = fakeIo({ '/work/repo': 'dir', '/work/repo/.git': 'dir', '/work/repo/src': 'dir' });
    assert.equal(detectProjectRoot('/work/repo/src', io), '/work/repo');
  });

  it('.git может быть файлом (worktree)', () => {
    const io = fakeIo({ '/work/repo': 'dir', '/work/repo/.git': 'gitdir: /elsewhere' });
    assert.equal(detectProjectRoot('/work/repo', io), '/work/repo');
  });

  it('без репозитория — null (дошли до корня ФС)', () => {
    assert.equal(detectProjectRoot('/work/plain', fakeIo({ '/work/plain': 'dir' })), null);
  });
});

describe('discoverDocSources', () => {
  it('README, CLAUDE.md, каталог docs и описания API', () => {
    const io = fakeIo({
      '/repo': 'dir',
      '/repo/README.md': '# проект',
      '/repo/CLAUDE.md': 'заметки',
      '/repo/AGENTS.md': 'агенты',
      '/repo/openapi.yaml': 'openapi: 3.0.0',
      '/repo/schema.graphql': 'type Query',
      '/repo/api.proto': 'message X {}',
      '/repo/docs': 'dir',
      '/repo/docs/guide.md': 'гайд',
      '/repo/src': 'dir',
      '/repo/package.json': '{}',
    });
    assert.deepEqual(discoverDocSources('/repo', io), [
      '/repo/AGENTS.md',
      '/repo/CLAUDE.md',
      '/repo/README.md',
      '/repo/api.proto',
      '/repo/docs',
      '/repo/openapi.yaml',
      '/repo/schema.graphql',
    ]);
  });

  it('код и посторонние файлы в документацию не попадают', () => {
    const io = fakeIo({
      '/repo': 'dir',
      '/repo/index.ts': 'код',
      '/repo/package-lock.json': '{}',
      '/repo/src': 'dir',
    });
    assert.deepEqual(discoverDocSources('/repo', io), []);
  });

  it('нечитаемый корень — пустой список', () => {
    assert.deepEqual(discoverDocSources('/нет', fakeIo({})), []);
  });
});

describe('detectPackageManager', () => {
  it('по lock-файлу', () => {
    assert.equal(detectPackageManager('/repo', fakeIo({ '/repo/pnpm-lock.yaml': 'x' })), 'pnpm');
    assert.equal(detectPackageManager('/repo', fakeIo({ '/repo/yarn.lock': 'x' })), 'yarn');
    assert.equal(detectPackageManager('/repo', fakeIo({ '/repo/bun.lockb': 'x' })), 'bun');
    assert.equal(detectPackageManager('/repo', fakeIo({ '/repo/package-lock.json': 'x' })), 'npm');
  });

  it('без lock-файла — не угадываем', () => {
    assert.equal(detectPackageManager('/repo', fakeIo({ '/repo/package.json': '{}' })), undefined);
  });
});

describe('detectProjectCommands', () => {
  it('берёт test/build/lint/start из scripts', () => {
    const manifest = JSON.stringify({
      scripts: { test: 'npm test', build: 'tsc', lint: '', deploy: 'ship' },
    });
    const commands = detectProjectCommands('/repo', fakeIo({ '/repo/package.json': manifest }));
    assert.deepEqual(commands, { test: 'npm test', build: 'tsc' });
  });

  it('нет package.json или он битый — команд нет', () => {
    assert.deepEqual(detectProjectCommands('/repo', fakeIo({})), {});
    assert.deepEqual(detectProjectCommands('/repo', fakeIo({ '/repo/package.json': '{битый' })), {});
  });

  it('манифест без scripts (в том числе scripts: null)', () => {
    assert.deepEqual(detectProjectCommands('/repo', fakeIo({ '/repo/package.json': '{}' })), {});
    const withNull = fakeIo({ '/repo/package.json': '{"scripts":null}' });
    assert.deepEqual(detectProjectCommands('/repo', withNull), {});
  });
});

describe('detectOrigin', () => {
  it('берёт url секции remote "origin"', () => {
    const config = [
      '[core]',
      '\trepositoryformatversion = 0',
      '[remote "origin"]',
      '\turl = git@github.com:vizgin/ai-advent.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    ].join('\n');
    const io = fakeIo({ '/repo/.git/config': config });
    assert.equal(detectOrigin('/repo', io), 'git@github.com:vizgin/ai-advent.git');
  });

  it('нет конфига или нет origin — undefined', () => {
    assert.equal(detectOrigin('/repo', fakeIo({})), undefined);
    assert.equal(detectOrigin('/repo', fakeIo({ '/repo/.git/config': '[core]' })), undefined);
  });
});

describe('loadProjectContext', () => {
  const tree = {
    '/repo': 'dir' as const,
    '/repo/.git': 'dir' as const,
    '/repo/.git/config': '[remote "origin"]\n\turl = https://example.com/x.git',
    '/repo/README.md': '# проект',
    '/repo/docs': 'dir' as const,
    '/repo/docs/guide.md': 'гайд',
    '/repo/package-lock.json': '{}',
    '/repo/package.json': '{"scripts":{"test":"npm test"}}',
  };

  it('собирает корень, имя, remote, документацию и команды', () => {
    const project = loadProjectContext('/repo', fakeIo(tree));
    assert.deepEqual(project, {
      root: '/repo',
      name: 'repo',
      origin: 'https://example.com/x.git',
      docSources: ['/repo/README.md', '/repo/docs'],
      packageManager: 'npm',
      commands: { test: 'npm test' },
    });
  });

  it('оверрайд документации заменяет автоопределение, пустой — нет', () => {
    const io = fakeIo(tree);
    assert.deepEqual(loadProjectContext('/repo', io, ['/repo/docs'])?.docSources, ['/repo/docs']);
    assert.deepEqual(loadProjectContext('/repo', io, [])?.docSources, [
      '/repo/README.md',
      '/repo/docs',
    ]);
  });

  it('без .git — не проект', () => {
    assert.equal(loadProjectContext('/plain', fakeIo({ '/plain': 'dir' })), null);
  });

  it('локальный проект без remote и без манифеста', () => {
    const io = fakeIo({ '/solo': 'dir', '/solo/.git': 'dir' });
    const project = loadProjectContext('/solo', io);
    assert.deepEqual(project, { root: '/solo', name: 'solo', docSources: [], commands: {} });
  });
});

describe('formatProjectContext / formatWorkspace', () => {
  const project: ProjectContext = {
    root: '/repo',
    name: 'repo',
    origin: 'https://example.com/x.git',
    docSources: ['/repo/README.md'],
    commands: { test: 'npm test', build: 'tsc', lint: 'eslint', start: 'node .' },
  };

  it('карточка содержит корень, remote, документацию и команды', () => {
    const card = formatProjectContext(project);
    assert.match(card, /Проект «repo»/);
    assert.match(card, /- корень: \/repo/);
    assert.match(card, /- remote: https:\/\/example\.com\/x\.git/);
    assert.match(card, /- документация: \/repo\/README\.md/);
    assert.match(card, /тесты: `npm test`; сборка: `tsc`; линтер: `eslint`; запуск: `node \.`/);
  });

  it('без remote, документации и команд — честные пометки', () => {
    const bare: ProjectContext = { root: '/bare', name: 'bare', docSources: [], commands: {} };
    const card = formatProjectContext(bare);
    assert.doesNotMatch(card, /remote/);
    assert.match(card, /- документация: не найдена/);
    assert.match(card, /- команды: не определены/);
  });

  it('несколько проектов — карточки и требование указывать repo явно', () => {
    const second: ProjectContext = { root: '/api', name: 'api', docSources: [], commands: {} };
    const workspace = formatWorkspace([project, second]);
    assert.match(workspace, /Проект «repo»/);
    assert.match(workspace, /Проект «api»/);
    assert.match(workspace, /указывай нужный репозиторий аргументом repo/);
  });

  it('один проект — без требования указывать repo; пусто — пустая строка', () => {
    assert.doesNotMatch(formatWorkspace([project]), /аргументом repo/);
    assert.equal(formatWorkspace([]), '');
  });
});

describe('nodeProjectIo (настоящая файловая система)', () => {
  it('различает файл, каталог и отсутствие пути; читает и перечисляет', () => {
    const root = mkdtempSync(join(tmpdir(), 'project-context-'));
    try {
      mkdirSync(join(root, 'docs'));
      writeFileSync(join(root, 'README.md'), '# демо');
      assert.equal(nodeProjectIo.stat(join(root, 'README.md')), 'file');
      assert.equal(nodeProjectIo.stat(join(root, 'docs')), 'dir');
      assert.equal(nodeProjectIo.stat(join(root, 'нет')), null);
      assert.equal(nodeProjectIo.readText(join(root, 'README.md')), '# демо');
      assert.deepEqual(nodeProjectIo.list(root).sort(), ['README.md', 'docs']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
