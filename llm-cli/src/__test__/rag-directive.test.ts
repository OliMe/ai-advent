import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSearchDocsTool, ragSearchDirective, formatRagResultForDisplay } from '../index.ts';
import { driveInteractive, clientWith } from './helpers.ts';
import { McpToolSet } from '../../../mcp-client/src/index.ts';
import type { ConnectFn, McpServerConfig } from '../../../mcp-client/src/index.ts';
import type { McpStore } from '../index.ts';
import type { ToolSpec } from '../../../core/src/index.ts';

const STDIO: McpServerConfig = { transport: 'stdio', command: 'x', args: [] };
const memoryStore = (initial: Map<string, McpServerConfig>): McpStore => {
  let servers = new Map(initial);
  return { load: () => new Map(servers), save: updated => (servers = new Map(updated)) };
};

describe('ragSearchDirective', () => {
  it('isSearchDocsTool по суффиксу', () => {
    assert.equal(isSearchDocsTool('rag__search_docs'), true);
    assert.equal(isSearchDocsTool('rag__list_indexes'), false);
  });

  it('formatRagResultForDisplay: оставляет трассу и заголовки источников, убирает тела', () => {
    const result =
      'Найдено фрагментов: 2 по запросу «q»:\n' +
      '🔎 кандидатов 20 → порог≥0.50: 12 → rerank(llm): 2, запрос переписан\n\n' +
      '[1] src › a.md › Раздел (0.900)\nтело первого фрагмента\n\n' +
      '[2] src › b.md › Другой (0.800)\nтело второго фрагмента';
    const shown = formatRagResultForDisplay(result);
    assert.match(shown, /🔎 кандидатов 20 → порог≥0\.50: 12 → rerank\(llm\): 2, запрос переписан/);
    assert.match(shown, /\[1\] src › a\.md › Раздел \(0\.900\)/);
    assert.match(shown, /\[2\] src › b\.md › Другой \(0\.800\)/);
    assert.doesNotMatch(shown, /тело первого фрагмента/); // тела фрагментов не показываем
  });

  it('есть search_docs → директива про поиск и источники; нет → null', () => {
    const withTool: ToolSpec[] = [{ name: 'rag__search_docs', description: '', parameters: {} }];
    const directive = ragSearchDirective(withTool);
    assert.match(directive ?? '', /search_docs/);
    assert.match(directive ?? '', /источник/i);
    assert.equal(
      ragSearchDirective([{ name: 'srv__echo', description: '', parameters: {} }]),
      null,
    );
  });
});

describe('интеграция: директива RAG подмешивается при подключённом search_docs', () => {
  it('агентный ход с инструментом search_docs проходит без ошибок', async t => {
    const connect: ConnectFn = async name => ({
      name,
      tools: () => [{ name: 'search_docs', description: 'RAG', parameters: { type: 'object' } }],
      call: async () => 'фрагменты',
      close: async () => {},
    });
    // Модель отвечает без вызова инструмента — важна лишь сборка ведущих сообщений (директивы).
    const client = clientWith(t, async () => ({
      content: 'ответ по документам',
      usage: undefined,
    }));
    const mcp = { toolSet: new McpToolSet(connect), store: memoryStore(new Map([['rag', STDIO]])) };
    const { finished, text } = driveInteractive(
      client,
      ['что в этом репозитории?', '/exit'],
      0.7,
      undefined,
      true,
      null,
      undefined,
      'window',
      6,
      undefined,
      mcp,
    );
    await finished;
    assert.match(text(), /ответ по документам/);
  });

  it('результат search_docs печатается в чат сводкой (трасса + источники, без тел)', async t => {
    const searchResult =
      'Найдено фрагментов: 1 по запросу «поиск»:\n' +
      '🔎 кандидатов 20 → rerank(llm): 1, запрос переписан\n\n' +
      '[1] /docs › places-mcp.md › Places (0.910)\nтело-фрагмента-скрыто';
    const connect: ConnectFn = async name => ({
      name,
      tools: () => [{ name: 'search_docs', description: 'RAG', parameters: { type: 'object' } }],
      call: async () => searchResult,
      close: async () => {},
    });
    let round = 0;
    const client = clientWith(t, async () => {
      round++;
      return round === 1
        ? {
            content: '',
            toolCalls: [
              {
                id: 'c1',
                type: 'function' as const,
                function: { name: 'rag__search_docs', arguments: '{"query":"поиск"}' },
              },
            ],
            usage: undefined,
          }
        : { content: 'ответ по источникам', usage: undefined };
    });
    const mcp = { toolSet: new McpToolSet(connect), store: memoryStore(new Map([['rag', STDIO]])) };
    const { finished, text } = driveInteractive(
      client,
      ['найди места рядом', '/exit'],
      0.7,
      undefined,
      true,
      null,
      undefined,
      'window',
      6,
      undefined,
      mcp,
    );
    await finished;
    const out = text();
    assert.match(out, /🔎 RAG-поиск:/);
    assert.match(out, /rerank\(llm\): 1, запрос переписан/); // трасса видна пользователю
    assert.match(out, /\[1\] \/docs › places-mcp\.md › Places \(0\.910\)/); // источник виден
    assert.doesNotMatch(out, /тело-фрагмента-скрыто/); // тело не печатаем
  });
});
