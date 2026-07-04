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

  it('formatRagResultForDisplay: трасса + заголовки + пометка ⚠, тела убраны', () => {
    const result =
      'Найдено фрагментов: 2 по запросу «q»:\n' +
      '🔎 кандидатов 20 → rerank(llm): 2 · уверенность 0.42 (низкая)\n' +
      '⚠ Низкая уверенность контекста (лучший косинус 0.42).\n\n' +
      '[1] a#0 · src › a.md › Раздел (0.420)\nтело первого фрагмента\n\n' +
      '[2] b#0 · src › b.md › Другой (0.400)\nтело второго фрагмента';
    const shown = formatRagResultForDisplay(result);
    assert.match(shown, /🔎 кандидатов 20 → rerank\(llm\): 2 · уверенность 0\.42 \(низкая\)/);
    assert.match(shown, /⚠ Низкая уверенность контекста/); // предупреждение видно пользователю
    assert.match(shown, /\[1\] a#0 · src › a\.md › Раздел \(0\.420\)/);
    assert.doesNotMatch(shown, /тело первого фрагмента/); // тела фрагментов не показываем
  });

  it('директива: 3 обязательные секции, дословные цитаты, режим «не знаю»; нет инструмента → null', () => {
    const withTool: ToolSpec[] = [{ name: 'rag__search_docs', description: '', parameters: {} }];
    const directive = ragSearchDirective(withTool) ?? '';
    assert.match(directive, /search_docs/);
    assert.match(directive, /Ответ:/);
    assert.match(directive, /Источники:/);
    assert.match(directive, /Цитаты:/);
    assert.match(directive, /chunk_id/);
    assert.match(directive, /дословн/i); // требование дословности цитат
    assert.match(directive, /Не знаю/i); // режим «не знаю»
    assert.match(directive, /по одной короткой на каждый источник/); // полный режим
    assert.equal(
      ragSearchDirective([{ name: 'srv__echo', description: '', parameters: {} }]),
      null,
    );
  });

  it('компактный режим: одна цитата вместо «на каждый источник»', () => {
    const withTool: ToolSpec[] = [{ name: 'rag__search_docs', description: '', parameters: {} }];
    const compact = ragSearchDirective(withTool, true) ?? '';
    assert.match(compact, /одна короткая ДОСЛОВНАЯ выдержка/);
    assert.doesNotMatch(compact, /по одной короткой на каждый источник/);
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

  it('RAG_ANSWER_COMPACT=1 — компактная директива, ход проходит без ошибок', async t => {
    const connect: ConnectFn = async name => ({
      name,
      tools: () => [{ name: 'search_docs', description: 'RAG', parameters: { type: 'object' } }],
      call: async () => 'фрагменты',
      close: async () => {},
    });
    const client = clientWith(t, async () => ({ content: 'компактный ответ', usage: undefined }));
    const mcp = { toolSet: new McpToolSet(connect), store: memoryStore(new Map([['rag', STDIO]])) };
    const previous = process.env.RAG_ANSWER_COMPACT;
    process.env.RAG_ANSWER_COMPACT = '1';
    try {
      const { finished, text } = driveInteractive(
        client,
        ['что тут?', '/exit'],
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
      assert.match(text(), /компактный ответ/);
    } finally {
      if (previous === undefined) delete process.env.RAG_ANSWER_COMPACT;
      else process.env.RAG_ANSWER_COMPACT = previous;
    }
  });

  it('невалидный ответ (выдуманная цитата) → перегенерация до валидного, ⚠ в выводе', async t => {
    const searchResult =
      'Найдено фрагментов: 1 по запросу «q»:\n' +
      '🔎 кандидатов 1 → rerank(none): 1 · уверенность 0.80\n\n' +
      '[1] doc#0 · /d › doc.md › Раздел (0.800)\n' +
      'find_places ищет организации рядом';
    const invalid = 'Ответ: выдумка\nИсточники:\n- other.md\nЦитаты:\n- выдуманная цитата';
    const valid =
      'Ответ: find_places.\nИсточники:\n- /d › doc.md · doc#0\n' +
      'Цитаты:\n- find_places ищет организации рядом';
    const connect: ConnectFn = async name => ({
      name,
      tools: () => [{ name: 'search_docs', description: 'RAG', parameters: { type: 'object' } }],
      call: async () => searchResult,
      close: async () => {},
    });
    let round = 0;
    const client = clientWith(t, async () => {
      round++;
      if (round === 1) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'c1',
              type: 'function' as const,
              function: { name: 'rag__search_docs', arguments: '{"query":"q"}' },
            },
          ],
          usage: undefined,
        };
      }
      // round 2 — невалидный финал; round 3 — перегенерация (askModel) отдаёт валидный.
      return { content: round === 2 ? invalid : valid, usage: undefined };
    });
    const mcp = { toolSet: new McpToolSet(connect), store: memoryStore(new Map([['rag', STDIO]])) };
    const { finished, text } = driveInteractive(
      client,
      ['вопрос', '/exit'],
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
    assert.match(out, /⚠ Цитаты не подтвердились \(попытка 1\)/); // гейт сработал
    assert.match(out, /find_places ищет организации рядом/); // показан перегенерированный валидный
    assert.doesNotMatch(out, /выдуманная цитата/); // невалидный ответ не показан
  });

  it('композиция с памятью задачи: RAG-гейт работает при включённой памяти', async t => {
    const searchResult =
      'Найдено фрагментов: 1 по запросу «q»:\n' +
      '🔎 кандидатов 1 → rerank(none): 1 · уверенность 0.80\n\n' +
      '[1] doc#0 · /d › doc.md › Раздел (0.800)\n' +
      'find_places ищет организации рядом';
    const valid =
      'Ответ: find_places.\nИсточники:\n- /d › doc.md · doc#0\n' +
      'Цитаты:\n- find_places ищет организации рядом';
    const connect: ConnectFn = async name => ({
      name,
      tools: () => [{ name: 'search_docs', description: 'RAG', parameters: { type: 'object' } }],
      call: async () => searchResult,
      close: async () => {},
    });
    const client = clientWith(t, async messages => {
      // Память задачи: запросы извлечения/консолидации содержат «JSON» — отвечаем пусто.
      if (messages.some(m => typeof m.content === 'string' && m.content.includes('JSON'))) {
        return { content: '{"task":[],"user":[]}', usage: undefined };
      }
      // RAG-ход: пока нет tool-результата — просим инструмент; после — финальный ответ.
      if (messages.some(m => m.role === 'tool')) {
        return { content: valid, usage: undefined };
      }
      return {
        content: '',
        toolCalls: [
          {
            id: 'c1',
            type: 'function' as const,
            function: { name: 'rag__search_docs', arguments: '{"query":"q"}' },
          },
        ],
        usage: undefined,
      };
    });
    const mcp = { toolSet: new McpToolSet(connect), store: memoryStore(new Map([['rag', STDIO]])) };
    const { finished, text } = driveInteractive(
      client,
      ['что делает doc?', '/exit'],
      0.7,
      undefined,
      true,
      null,
      undefined,
      'window',
      6,
      { enabled: true, profileStore: null, taskStore: null, initialTaskTitle: 'Про doc' },
      mcp,
    );
    await finished;
    const out = text();
    assert.match(out, /find_places ищет организации рядом/); // гейт пропустил валидный ответ
    assert.match(out, /память/); // память задачи активна в том же прогоне
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
