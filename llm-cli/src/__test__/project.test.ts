import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isGitBranchTool,
  isGitStatusTool,
  docSourcesOverride,
  resolveWorkspace,
  workspaceDocSources,
  fetchGitBranch,
  formatProjectCard,
  formatProjectList,
  removeProjectRoot,
} from '../index.ts';
import type { ProjectContext, ProjectIo, Session, ToolSet } from '../index.ts';

/** Проект как карта путей: 'dir' — каталог, строка — содержимое файла. */
function fakeIo(tree: Record<string, 'dir' | string>): ProjectIo {
  return {
    stat: path => {
      const entry = tree[path];
      return entry === undefined ? null : entry === 'dir' ? 'dir' : 'file';
    },
    list: path => {
      const prefix = `${path}/`;
      return Object.keys(tree)
        .filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
        .map(key => key.slice(prefix.length));
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

const REPO_TREE = {
  '/work/repo': 'dir' as const,
  '/work/repo/.git': 'dir' as const,
  '/work/repo/README.md': '# проект',
  '/work/repo/src': 'dir' as const,
  '/work/api': 'dir' as const,
  '/work/api/.git': 'dir' as const,
  '/work/api/openapi.yaml': 'openapi: 3.0.0',
};

/** Сессия с привязанными проектами. */
function sessionWith(projects?: string[]): Session {
  return {
    version: 1,
    id: 'x',
    model: 'm',
    ...(projects === undefined ? {} : { projects }),
    createdAt: 'now',
    updatedAt: 'now',
    messages: [],
  };
}

/** Набор инструментов с фиксированным ответом git_branch. */
function toolSetWith(
  names: string[],
  answer: string,
  calls: Record<string, unknown>[] = [],
): ToolSet {
  return {
    specs: () => names.map(name => ({ name, description: '', parameters: { type: 'object' } })),
    call: async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);
      return answer;
    },
  } as unknown as ToolSet;
}

describe('распознавание git-инструментов', () => {
  it('учитывает неймспейс сервера', () => {
    assert.ok(isGitBranchTool('git__git_branch'));
    assert.ok(isGitStatusTool('git__git_status'));
    assert.equal(isGitBranchTool('rag__search_docs'), false);
    assert.equal(isGitStatusTool('git__git_log'), false);
  });
});

describe('docSourcesOverride', () => {
  it('пусто и не задано — undefined', () => {
    assert.equal(docSourcesOverride(undefined), undefined);
    assert.equal(docSourcesOverride(' , '), undefined);
  });

  it('список через запятую', () => {
    assert.deepEqual(docSourcesOverride('/a/README.md, /a/docs'), ['/a/README.md', '/a/docs']);
  });
});

describe('resolveWorkspace', () => {
  it('привязанные проекты сессии — в порядке привязки', () => {
    const projects = resolveWorkspace(
      sessionWith(['/work/repo', '/work/api']),
      '/где-угодно',
      fakeIo(REPO_TREE),
    );
    assert.deepEqual(
      projects.map(project => project.name),
      ['repo', 'api'],
    );
  });

  it('путь, переставший быть репозиторием, выпадает', () => {
    const projects = resolveWorkspace(
      sessionWith(['/work/repo', '/work/удалён']),
      '/x',
      fakeIo(REPO_TREE),
    );
    assert.deepEqual(
      projects.map(project => project.root),
      ['/work/repo'],
    );
  });

  it('ничего не привязано — автодетект по текущему каталогу', () => {
    const projects = resolveWorkspace(sessionWith(), '/work/repo/src', fakeIo(REPO_TREE));
    assert.deepEqual(
      projects.map(project => project.root),
      ['/work/repo'],
    );
  });

  it('автодетект вне репозитория — пустое пространство', () => {
    assert.deepEqual(resolveWorkspace(sessionWith(), '/tmp', fakeIo(REPO_TREE)), []);
  });

  it('оверрайд документации применяется', () => {
    const projects = resolveWorkspace(sessionWith(['/work/repo']), '/x', fakeIo(REPO_TREE), [
      '/work/repo/docs',
    ]);
    assert.deepEqual(projects[0]?.docSources, ['/work/repo/docs']);
  });

  it('автодетект в каталоге без .git по всей цепочке вверх — пусто', () => {
    assert.deepEqual(resolveWorkspace(sessionWith(), '/work', fakeIo({ '/work': 'dir' })), []);
  });
});

describe('workspaceDocSources', () => {
  it('документация всех проектов пространства', () => {
    const projects = resolveWorkspace(
      sessionWith(['/work/repo', '/work/api']),
      '/x',
      fakeIo(REPO_TREE),
    );
    assert.deepEqual(workspaceDocSources(projects), [
      '/work/repo/README.md',
      '/work/api/openapi.yaml',
    ]);
  });
});

describe('fetchGitBranch', () => {
  it('берёт ветку из ответа git_branch по указанному репозиторию', async () => {
    const calls: Record<string, unknown>[] = [];
    const toolSet = toolSetWith(['git__git_branch'], 'Репозиторий: /work/repo\nВетка: main', calls);
    assert.equal(await fetchGitBranch(toolSet, '/work/repo'), 'main');
    assert.deepEqual(calls, [{ repo: '/work/repo' }]);
  });

  it('нет инструмента — null (ветку не выдумываем)', async () => {
    assert.equal(await fetchGitBranch(toolSetWith(['rag__search_docs'], 'x'), '/r'), null);
  });

  it('ответ без ветки — null', async () => {
    assert.equal(await fetchGitBranch(toolSetWith(['git__git_branch'], 'Отказ'), '/r'), null);
  });
});

describe('карточка и список проектов', () => {
  const project: ProjectContext = {
    root: '/work/repo',
    name: 'repo',
    docSources: ['/work/repo/README.md'],
    commands: { test: 'npm test' },
  };

  it('карточка с веткой и без', () => {
    assert.match(formatProjectCard(project, 'main'), /- ветка: main/);
    assert.doesNotMatch(formatProjectCard(project, null), /ветка/);
  });

  it('список проектов с ветками', () => {
    const second: ProjectContext = { root: '/work/api', name: 'api', docSources: [], commands: {} };
    const list = formatProjectList([project, second], ['main']);
    assert.match(list, /Проекты \(2\)/);
    assert.match(list, /Проект «repo»/);
    assert.match(list, /- ветка: main/);
    // Второму проекту ветка не пришла — карточка без неё, а не с выдуманной.
    assert.match(list, /Проект «api»/);
  });

  it('пусто — подсказка, как привязать', () => {
    assert.match(formatProjectList([], []), /Проект не привязан.*\/project add/s);
  });
});

describe('removeProjectRoot', () => {
  const roots = ['/work/repo', '/work/api'];

  it('по имени и по пути (с хвостовым слэшем)', () => {
    assert.deepEqual(removeProjectRoot(roots, 'api'), ['/work/repo']);
    assert.deepEqual(removeProjectRoot(roots, '/work/repo/'), ['/work/api']);
  });

  it('нет такого проекта — null, а не молчаливый успех', () => {
    assert.equal(removeProjectRoot(roots, 'нет'), null);
  });
});
