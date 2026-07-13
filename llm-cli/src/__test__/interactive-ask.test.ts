import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientWith, makeConfig } from '../../../core/src/__test__/helpers.ts';
import { driveInteractive, fakeStore, makeSession } from './helpers.ts';
import { McpToolSet } from '../../../mcp-client/src/index.ts';
import type { ConnectFn, McpServerConfig } from '../../../mcp-client/src/index.ts';
import type { McpStore } from '../index.ts';

const STDIO: McpServerConfig = { transport: 'stdio', command: 'x', args: [] };

/** Временный проект: документация + «код», который ассистент читает инструментом. */
let projectRoot: string;

before(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'llm-cli-ask-'));
  mkdirSync(join(projectRoot, '.git'));
  writeFileSync(join(projectRoot, 'README.md'), '# сервис\n');
});

after(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function memoryStore(initial: Map<string, McpServerConfig>): McpStore {
  let servers = new Map(initial);
  return { load: () => new Map(servers), save: updated => (servers = new Map(updated)) };
}

const SEARCH_RESULT =
  '🔎 кандидатов 20 → rerank(mmr): 1 · уверенность 0.80\n' +
  '[1] README.md#1 · docs › README.md › Обзор (0.80)\n' +
  'Сервис принимает заказы и считает доставку.';

const CODE =
  'export function calculateDelivery(order: Order): number {\n  return order.weight * 10;\n}';

/** MCP-серверы rag + git: поиск по документации и чтение кода. */
const projectServers: ConnectFn = async name => ({
  name,
  tools: () =>
    name === 'rag'
      ? [{ name: 'search_docs', description: 'поиск', parameters: { type: 'object' } }]
      : [
          { name: 'git_branch', description: 'ветка', parameters: { type: 'object' } },
          { name: 'git_status', description: 'статус', parameters: { type: 'object' } },
          { name: 'git_list_files', description: 'файлы', parameters: { type: 'object' } },
          { name: 'git_grep', description: 'поиск', parameters: { type: 'object' } },
          { name: 'read_file', description: 'файл', parameters: { type: 'object' } },
        ],
  call: async (tool: string) => {
    if (tool === 'search_docs') return SEARCH_RESULT;
    if (tool === 'git_branch') return 'Репозиторий: /x\nВетка: main';
    if (tool === 'git_status') return ' M src/delivery.ts';
    if (tool === 'git_list_files') return 'src/delivery.ts\nREADME.md';
    if (tool === 'git_grep') return 'src/delivery.ts:1:export function calculateDelivery(';
    return CODE;
  },
  close: async () => {},
});

/** Сессия с привязанным временным проектом. */
function sessionWithProject() {
  const session = makeSession();
  session.projects = [projectRoot];
  return session;
}

/** MCP с обоими серверами. */
function projectMcp() {
  return {
    toolSet: new McpToolSet(projectServers),
    store: memoryStore(
      new Map([
        ['rag', STDIO],
        ['git', STDIO],
      ]),
    ),
  };
}

describe('/ask — ассистент разработчика', () => {
  it('ищет в документации, читает код инструментом и отвечает с источниками и цитатой кода', async t => {
    const client = clientWith(t, messages =>
      // Ход отдельным вызовом просит назвать шаблоны для grep — узнаём его по system-промпту.
      (messages[0]?.content ?? '').includes('ПОИСКОВЫХ ШАБЛОНА')
        ? { content: 'calculateDelivery' }
        : {
            content: [
              'Ответ: доставка считается в src/delivery.ts, функция calculateDelivery.',
              'Источники:',
              '- src/delivery.ts',
              'Цитаты:',
              '- «export function calculateDelivery(order: Order): number»',
            ].join('\n'),
          },
    );

    const { finished, text } = driveInteractive(
      client,
      ['/ask где считается доставка?', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
      sessionWithProject(),
      'window',
      6,
      undefined,
      projectMcp(),
    );
    await finished;

    const out = text();
    // Поиск по документации и по коду — принудительный; файл дочитан ходом, а не по инициативе модели.
    assert.match(out, /search_docs/);
    assert.match(out, /git_grep/);
    assert.match(out, /read_file/);
    assert.match(out, /calculateDelivery/);
    assert.match(out, /Источники:/);
  });

  it('выдумка о коде заворачивается: ответ не подтверждён доказательствами', async t => {
    const client = clientWith(t, messages =>
      (messages[0]?.content ?? '').includes('ПОИСКОВЫХ ШАБЛОНА')
        ? { content: '' }
        : {
            content: [
              'Ответ: доставка считается в src/pricing/DeliveryCalculator.ts.',
              'Источники:',
              '- src/pricing/DeliveryCalculator.ts',
              'Цитаты:',
              '- «class DeliveryCalculator implements PriceStrategy»',
            ].join('\n'),
          },
    );

    const { finished, text } = driveInteractive(
      client,
      ['/ask где считается доставка?', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
      sessionWithProject(),
      'window',
      6,
      undefined,
      projectMcp(),
    );
    await finished;

    assert.match(text(), /Не могу подтвердить ответ дословными цитатами/);
    assert.doesNotMatch(text(), /DeliveryCalculator implements PriceStrategy/);
  });

  it('/ask без вопроса — подсказка по использованию', async t => {
    const client = clientWith(t, () => ({ content: 'X' }));
    const { finished, text } = driveInteractive(
      client,
      ['/ask', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
      sessionWithProject(),
      'window',
      6,
      undefined,
      projectMcp(),
    );
    await finished;

    assert.match(text(), /Спросите о проекте: \/ask <вопрос>/);
  });

  it('нет привязанного проекта — честный отказ вместо ответа наугад', async t => {
    const client = clientWith(t, () => ({ content: 'X' }));
    const session = makeSession();
    // Проект пуст и автодетект по cwd отключаем, подсунув каталог без репозитория.
    session.projects = ['/такого/проекта/нет'];
    const { finished, text } = driveInteractive(
      client,
      ['/ask что это за проект?', '/exit'],
      0.7,
      makeConfig(),
      true,
      fakeStore(),
      session,
      'window',
      6,
      undefined,
      projectMcp(),
    );
    await finished;

    assert.match(text(), /Проект не привязан/);
  });

  it('без MCP отвечать нечем — просим подключить серверы, а не выдумываем', async t => {
    const client = clientWith(t, () => ({ content: 'X' }));
    const { finished, text } = driveInteractive(
      client,
      ['/ask где считается доставка?', '/exit'],
      0.7,
      makeConfig(),
      false,
      fakeStore(),
      sessionWithProject(),
    );
    await finished;

    assert.match(text(), /Нет инструментов/);
  });
});
