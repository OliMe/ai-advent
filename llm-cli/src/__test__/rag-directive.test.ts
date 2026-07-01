import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSearchDocsTool, ragSearchDirective } from '../index.ts';
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
});
