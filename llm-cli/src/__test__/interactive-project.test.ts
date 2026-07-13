import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clientWithStream,
  taskRunClient,
  driveInteractive,
  fakeStore,
  makeSession,
} from './helpers.ts';
import { makeConfig } from '../../../core/src/__test__/helpers.ts';
import { McpToolSet } from '../../../mcp-client/src/index.ts';
import type { ConnectFn, McpServerConfig } from '../../../mcp-client/src/index.ts';
import type { McpStore } from '../index.ts';

const STDIO: McpServerConfig = { transport: 'stdio', command: 'x', args: [] };

/** Хранилище MCP-конфигурации в памяти. */
function memoryStore(initial: Map<string, McpServerConfig>): McpStore {
  let servers = new Map(initial);
  return { load: () => new Map(servers), save: updated => (servers = new Map(updated)) };
}

/** MCP-сервер git: отвечает веткой либо падает (проверяем, что команда это переживает). */
function gitServer(answer: () => string): ConnectFn {
  return async name => ({
    name,
    tools: () => [{ name: 'git_branch', description: 'ветка', parameters: { type: 'object' } }],
    call: async () => answer(),
    close: async () => {},
  });
}

/**
 * Временный «чужой» проект: каталог с .git и документацией. Настоящая ФС — команда /project читает
 * её напрямую (nodeProjectIo), и подменять её здесь значило бы проверять не то, что работает.
 */
let projectRoot: string;

before(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'llm-cli-project-'));
  mkdirSync(join(projectRoot, '.git'));
  mkdirSync(join(projectRoot, 'docs'));
  writeFileSync(join(projectRoot, 'README.md'), '# демо-проект\n');
  writeFileSync(join(projectRoot, 'docs', 'guide.md'), 'гайд\n');
  writeFileSync(join(projectRoot, 'package.json'), '{"scripts":{"test":"npm test"}}');
  writeFileSync(join(projectRoot, 'package-lock.json'), '{}');
});

after(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('/project', () => {
  it('привязывает локальный проект: карточка с документацией и командами, запись в сессию', async t => {
    const client = clientWithStream(t, () => 'X');
    const store = fakeStore();
    const session = makeSession();
    const { finished, text } = driveInteractive(
      client,
      [`/project add ${projectRoot}`, '/exit'],
      0.7,
      makeConfig(),
      true,
      store,
      session,
    );
    await finished;

    assert.deepEqual(session.projects, [projectRoot]);
    assert.ok(store.saved.length >= 1);
    const out = text();
    assert.match(out, /Проект привязан/);
    assert.match(out, /- документация: .*README\.md, .*docs/);
    assert.match(out, /- команды: тесты: `npm test`/);
    // Без MCP ветку узнать не у кого — и она не выдумывается.
    assert.doesNotMatch(out, /- ветка:/);
  });

  it('показывает привязанные проекты и отвязывает по имени', async t => {
    const client = clientWithStream(t, () => 'X');
    const session = makeSession();
    session.projects = [projectRoot];
    const projectName = projectRoot.split('/').at(-1) as string;
    const { finished, text } = driveInteractive(
      client,
      ['/project', `/project remove ${projectName}`, '/project', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
      session,
    );
    await finished;

    assert.equal(session.projects, undefined);
    const out = text();
    assert.match(out, /Проекты \(1\)/);
    assert.match(out, new RegExp(`Проект «${projectName}»`));
    assert.match(out, /Проект отвязан/);
  });

  it('несколько проектов: оба в списке, удаление одного, /project off отвязывает все', async t => {
    const second = mkdtempSync(join(tmpdir(), 'llm-cli-project2-'));
    mkdirSync(join(second, '.git'));
    try {
      const client = clientWithStream(t, () => 'X');
      const session = makeSession();
      const secondName = second.split('/').at(-1) as string;
      const { finished, text } = driveInteractive(
        client,
        [
          `/project add ${projectRoot}`,
          `/project add ${second}`,
          '/projects',
          `/project remove ${secondName}`,
          '/project off',
          '/exit',
        ],
        0.7,
        makeConfig(),
        true,
        fakeStore(),
        session,
      );
      await finished;

      // После удаления второго остаётся первый (список не обнуляется), затем off снимает всё.
      assert.equal(session.projects, undefined);
      assert.match(text(), /Проекты \(2\)/);
      assert.match(text(), new RegExp(`Проект отвязан: ${secondName}`));
      assert.match(text(), /Проекты отвязаны/);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('повторная привязка того же проекта не дублирует его', async t => {
    const client = clientWithStream(t, () => 'X');
    const session = makeSession();
    const { finished } = driveInteractive(
      client,
      [`/project add ${projectRoot}`, `/project add ${projectRoot}`, '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
      session,
    );
    await finished;

    assert.deepEqual(session.projects, [projectRoot]);
  });

  it('несуществующий путь и каталог без .git — внятный отказ, привязки нет', async t => {
    const plain = mkdtempSync(join(tmpdir(), 'llm-cli-plain-'));
    try {
      const client = clientWithStream(t, () => 'X');
      const session = makeSession();
      const { finished, text } = driveInteractive(
        client,
        ['/project add /такого/пути/нет', `/project add ${plain}`, '/project remove нет', '/exit'],
        0.7,
        makeConfig(),
        true,
        fakeStore(),
        session,
      );
      await finished;

      assert.equal(session.projects, undefined);
      assert.match(text(), /Каталог не найден/);
      assert.match(text(), /Не git-репозиторий/);
      assert.match(text(), /Проект не привязан: нет/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('с подключённым git-mcp карточка показывает настоящую ветку', async t => {
    const client = clientWithStream(t, () => 'X');
    const session = makeSession();
    const mcp = {
      toolSet: new McpToolSet(gitServer(() => 'Репозиторий: /x\nВетка: feature/day-31')),
      store: memoryStore(new Map([['git', STDIO]])),
    };
    const { finished, text } = driveInteractive(
      client,
      [`/project add ${projectRoot}`, '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
      session,
      'window',
      6,
      undefined,
      mcp,
    );
    await finished;

    assert.match(text(), /- ветка: feature\/day-31/);
  });

  it('сбой git-сервера не роняет команду — карточка без ветки', async t => {
    const client = clientWithStream(t, () => 'X');
    const session = makeSession();
    const mcp = {
      toolSet: new McpToolSet(
        gitServer(() => {
          throw new Error('git-сервер отвалился');
        }),
      ),
      store: memoryStore(new Map([['git', STDIO]])),
    };
    const { finished, text } = driveInteractive(
      client,
      [`/project add ${projectRoot}`, '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
      session,
      'window',
      6,
      undefined,
      mcp,
    );
    await finished;

    assert.match(text(), /Проект привязан/);
    assert.doesNotMatch(text(), /- ветка:/);
  });

  it('без привязки — автодетект по текущему каталогу (llm-cli запущен внутри репозитория)', async t => {
    const client = clientWithStream(t, () => 'X');
    const { finished, text } = driveInteractive(client, ['/project', '/exit']);
    await finished;

    // cwd тестов — пакет llm-cli внутри репозитория ai-advent: он и определяется как проект.
    assert.match(text(), /📁 Проект \(по текущему каталогу\): ai-advent/);
    assert.match(text(), /Проекты \(1\)/);
  });
});

describe('проект в пайплайне (/run)', () => {
  it('планирование и проверка ищут в документации проекта, а карточка идёт всем этапам', async t => {
    const searched: string[] = [];
    const prompts: string[] = [];
    const client = taskRunClient(t);
    // Перехватываем промпты этапов: карточка проекта должна быть в контексте каждого агента.
    const original = client.completeWithUsage.bind(client);
    t.mock.method(client, 'completeWithUsage', async (messages: Parameters<typeof original>[0]) => {
      prompts.push(messages.map(message => message.content).join('\n'));
      return original(messages);
    });

    const ragServer: ConnectFn = async name => ({
      name,
      tools: () => [{ name: 'search_docs', description: 'поиск', parameters: { type: 'object' } }],
      call: async (_tool: string, args: Record<string, unknown>) => {
        searched.push(String(args.query));
        return '[1] README.md#1 · docs › README › Обзор (0.9)\nПроект собирается через npm test.';
      },
      close: async () => {},
    });

    const session = makeSession();
    session.projects = [projectRoot];
    const { finished } = driveInteractive(
      client,
      ['/run Добавить функцию суммы', 'да', 'да', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
      session,
      'window',
      6,
      undefined,
      { toolSet: new McpToolSet(ragServer), store: memoryStore(new Map([['rag', STDIO]])) },
    );
    await finished;

    // Поиск по докам проекта — ровно на тех этапах, где он решает (планирование и проверка),
    // по КАЖДОМУ источнику документации проекта (README.md + docs) → 2 этапа × 2 источника.
    assert.equal(searched.length, 4);
    assert.ok(searched.every(query => query === 'Добавить функцию суммы'));
    // Карточка проекта — в контексте агентов этапов (имя временного проекта в промптах).
    const projectName = projectRoot.split('/').at(-1) as string;
    assert.ok(prompts.some(prompt => prompt.includes(`Проект «${projectName}»`)));
  });
});
