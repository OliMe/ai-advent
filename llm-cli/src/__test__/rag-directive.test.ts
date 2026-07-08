import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSearchDocsTool,
  ragSearchDirective,
  formatRagResultForDisplay,
  queryMentionsSource,
  RECALL_SENTINEL,
} from '../index.ts';
import { driveInteractive, clientWith, makeSession } from './helpers.ts';
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
    assert.match(directive, /дословн/i); // ≥1 цитата-якорь дословная
    assert.match(directive, /якорь/); // требование дословного якоря
    assert.match(directive, /СИНТЕЗ/i); // синтез в теле разрешён (День 25 п.2)
    assert.match(directive, /Не знаю/i); // режим «не знаю»
    assert.match(directive, /НЕ конструируй команды/); // полный режим
    // Формат УСЛОВНЫЙ: секции только когда искали по докам; обычные ответы — без них (иначе
    // подключённый rag-mcp навязывал бы пустые Источники/Цитаты каждому ответу).
    assert.match(directive, /ТОЛЬКО когда ответ построен на результатах search_docs/);
    assert.match(directive, /БЕЗ секций «Источники» и «Цитаты»/);
    assert.equal(
      ragSearchDirective([{ name: 'srv__echo', description: '', parameters: {} }]),
      null,
    );
  });

  it('компактный режим: одна дословная цитата, без указания «НЕ конструируй команды»', () => {
    const withTool: ToolSpec[] = [{ name: 'rag__search_docs', description: '', parameters: {} }];
    const compact = ragSearchDirective(withTool, true) ?? '';
    assert.match(compact, /минимум ОДНА короткая ДОСЛОВНАЯ выдержка/);
    assert.doesNotMatch(compact, /НЕ конструируй команды/);
  });
});

describe('queryMentionsSource', () => {
  it('источник в вопросе (github/URL/путь) → true', () => {
    for (const t of [
      'что в github.com/perplexityai/bumblebee?',
      'разбери https://example.com/docs',
      'проиндексируй ./docs',
      'посмотри ~/projects/app',
      'что в /Users/me/repo?',
      'глянь ../shared',
    ]) {
      assert.equal(queryMentionsSource(t), true, `для «${t}»`);
    }
  });

  it('обычный вопрос без источника → false (в т.ч. «и/или»)', () => {
    for (const t of [
      'Назови столицу Австралии.',
      'напиши функцию сортировки пузырьком',
      'выбери и/или предложи вариант',
    ]) {
      assert.equal(queryMentionsSource(t), false, `для «${t}»`);
    }
  });
});

describe('интеграция: директива RAG подмешивается при подключённом search_docs', () => {
  const ragConnect: ConnectFn = async name => ({
    name,
    tools: () => [{ name: 'search_docs', description: 'RAG', parameters: { type: 'object' } }],
    call: async () => 'фрагменты',
    close: async () => {},
  });
  /** Клиент, запоминающий, попала ли RAG-директива в system-сообщения запроса. */
  const directiveSpyClient = (t: Parameters<typeof clientWith>[0], seen: { directive: boolean }) =>
    clientWith(t, async messages => {
      if (messages.some(m => m.role === 'system' && /search_docs/.test(m.content))) {
        seen.directive = true;
      }
      return { content: 'ответ модели', usage: undefined };
    });

  it('обычный вопрос (нет grounded, нет источника в тексте) → директива НЕ подмешивается', async t => {
    const seen = { directive: false };
    const mcp = {
      toolSet: new McpToolSet(ragConnect),
      store: memoryStore(new Map([['rag', STDIO]])),
    };
    const { finished, text } = driveInteractive(
      directiveSpyClient(t, seen),
      ['Назови столицу Австралии.', '/exit'],
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
    assert.match(text(), /ответ модели/);
    assert.equal(seen.directive, false); // rag подключён, но формат Источники/Цитаты не навязан
  });

  it('источник назван в вопросе (github.com) → директива подмешивается', async t => {
    const seen = { directive: false };
    const mcp = {
      toolSet: new McpToolSet(ragConnect),
      store: memoryStore(new Map([['rag', STDIO]])),
    };
    const { finished } = driveInteractive(
      directiveSpyClient(t, seen),
      ['что в github.com/o/r?', '/exit'],
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
    assert.equal(seen.directive, true); // источник в запросе → RAG уместен → директива есть
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

  it('RAG_FAITHFULNESS_CHECK=1 — судья бракует, перегенерация до достоверного, ↻ в выводе', async t => {
    const searchResult =
      'Найдено фрагментов: 1 по запросу «q»:\n' +
      '🔎 кандидатов 1 → rerank(none): 1 · уверенность 0.80\n\n' +
      '[1] doc#0 · /d › doc.md › Раздел (0.800)\n' +
      'find_places ищет организации рядом';
    // Оба ответа локально валидны (реальный источник + дословная цитата); судья бракует первый.
    const answer1 =
      'Ответ: find_places, а также умеет доставку пиццы.\nИсточники:\n- /d › doc.md · doc#0\n' +
      'Цитаты:\n- find_places ищет организации рядом';
    const answer2 =
      'Ответ: find_places ищет организации рядом.\nИсточники:\n- /d › doc.md · doc#0\n' +
      'Цитаты:\n- find_places ищет организации рядом';
    const connect: ConnectFn = async name => ({
      name,
      tools: () => [{ name: 'search_docs', description: 'RAG', parameters: { type: 'object' } }],
      call: async () => searchResult,
      close: async () => {},
    });
    let checkerCall = 0;
    const client = clientWith(t, async messages => {
      const hasText = (needle: string) =>
        messages.some(m => typeof m.content === 'string' && m.content.includes(needle));
      // Судья достоверности: первый раз бракует (выдумка про пиццу), затем «OK».
      if (hasText('контролёр достоверности')) {
        return {
          content: checkerCall++ === 0 ? '- доставка пиццы не в источниках' : 'OK',
          usage: undefined,
        };
      }
      // Перегенерация после судьи: замечание содержит «без опоры на источники».
      if (hasText('без опоры на источники')) {
        return { content: answer2, usage: undefined };
      }
      if (messages.some(m => m.role === 'tool')) {
        return { content: answer1, usage: undefined };
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
    const previous = process.env.RAG_FAITHFULNESS_CHECK;
    process.env.RAG_FAITHFULNESS_CHECK = '1';
    try {
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
      assert.match(out, /↻ достоверность \(попытка 1\)/); // судья забраковал
      assert.match(out, /доставка пиццы не в источниках/); // названо неподкреплённое
      assert.doesNotMatch(out, /умеет доставку пиццы/); // забракованный ответ не финальный
    } finally {
      if (previous === undefined) delete process.env.RAG_FAITHFULNESS_CHECK;
      else process.env.RAG_FAITHFULNESS_CHECK = previous;
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
    // Адресный фидбэк: причина ⚠ называет поддельный источник и отсутствие дословного якоря.
    assert.match(out, /источник не найден.*other\.md/);
    assert.match(out, /якоря/);
    assert.doesNotMatch(out, /Ответ: выдумка/); // но тело невалидного ОТВЕТА финальным не показано
  });

  // Grounded-режим, ход-воспоминание (День 25 Этап 3). Источник привязан к сессии; лексический
  // маркер «напомни» → recall (LLM-флаг не нужен, память в тесте выкл).
  const groundedConnect: ConnectFn = async name => ({
    name,
    tools: () => [{ name: 'search_docs', description: 'RAG', parameters: { type: 'object' } }],
    call: async () => searchDoc,
    close: async () => {},
  });
  const searchDoc =
    'Найдено фрагментов: 1 по запросу «q»:\n' +
    '🔎 кандидатов 1 → rerank(none): 1 · уверенность 0.80\n\n' +
    '[1] doc#0 · /d › doc.md › Раздел (0.800)\n' +
    'find_places ищет организации рядом';
  const validGrounded =
    'Ответ: find_places.\nИсточники:\n- /d › doc.md · doc#0\n' +
    'Цитаты:\n- find_places ищет организации рядом';

  it('воспоминание с ответом в истории → дословный повтор, без форс-поиска и гейта', async t => {
    const recalled =
      'Ответ: Каталог передаётся флагом --exposure-catalog <path>.\n' +
      'Источники:\n- threat_intel/README.md › Catalogs · 0\n' +
      'Цитаты:\n- «Pass a catalog with --exposure-catalog»';
    const client = clientWith(t, async messages => {
      const head = messages[0]?.content ?? '';
      // Проба «повтори из истории» (RECALL_SYSTEM_PROMPT содержит «воспоминание») → готовый ответ.
      if (head.includes('воспоминание')) return { content: recalled, usage: undefined };
      return { content: validGrounded, usage: undefined };
    });
    const mcp = {
      toolSet: new McpToolSet(groundedConnect),
      store: memoryStore(new Map([['rag', STDIO]])),
    };
    const { finished, text } = driveInteractive(
      client,
      ['напомни, каким флагом передать каталог компрометаций?', '/exit'],
      0.7,
      undefined,
      true,
      null,
      { ...makeSession(), ragSources: ['/docs'] },
      'window',
      6,
      undefined,
      mcp,
    );
    await finished;
    const out = text();
    assert.match(out, /--exposure-catalog/); // воспроизведённый ответ показан
    assert.doesNotMatch(out, /🔎 RAG-поиск/); // форс-поиск НЕ запускался
    assert.doesNotMatch(out, /🔧 инструмент rag__search_docs/);
    assert.doesNotMatch(out, /🧭/); // трасса вызовов пуста — инструменты не звались
    assert.doesNotMatch(out, /⚠ Цитаты не подтвердились/); // цитатный гейт НЕ запускался
    assert.doesNotMatch(out, /НЕТ_ОТВЕТА_В_ИСТОРИИ/); // сентинел не показан
  });

  it('воспоминание без ответа в истории (сентинел) → молчаливый откат на grounded-поиск', async t => {
    const client = clientWith(t, async messages => {
      const head = messages[0]?.content ?? '';
      if (head.includes('воспоминание')) return { content: RECALL_SENTINEL, usage: undefined };
      return { content: validGrounded, usage: undefined }; // grounded-ответ после отката (пройдёт гейт)
    });
    const mcp = {
      toolSet: new McpToolSet(groundedConnect),
      store: memoryStore(new Map([['rag', STDIO]])),
    };
    const { finished, text } = driveInteractive(
      client,
      ['напомни, каким флагом передать каталог?', '/exit'],
      0.7,
      undefined,
      true,
      null,
      { ...makeSession(), ragSources: ['/docs'] },
      'window',
      6,
      undefined,
      mcp,
    );
    await finished;
    const out = text();
    assert.doesNotMatch(out, /НЕТ_ОТВЕТА_В_ИСТОРИИ/); // сентинел НЕ утёк в вывод
    assert.match(out, /🧭.*rag__search_docs/); // откат: форс-поиск сработал (трасса вызовов)
    assert.match(out, /find_places ищет организации рядом/); // показан grounded-ответ
  });

  it('grounded: первый проход tool-free — посторонний инструмент НЕ вызывается', async t => {
    const called: string[] = [];
    // Сервер отдаёт search_docs (для форс-поиска) + do_thing (мутирующий побочный инструмент).
    const connect: ConnectFn = async name => ({
      name,
      tools: () => [
        { name: 'search_docs', description: 'RAG', parameters: { type: 'object' } },
        { name: 'do_thing', description: 'side effect', parameters: { type: 'object' } },
      ],
      call: async (toolName: string) => {
        called.push(toolName);
        return toolName.endsWith('search_docs') ? searchDoc : 'ok';
      },
      close: async () => {},
    });
    // Модель «пытается» дёрнуть посторонний инструмент — в grounded это игнорируется (askModel).
    const client = clientWith(t, async messages => {
      const head = messages[0]?.content ?? '';
      if (head.includes('воспоминание')) return { content: RECALL_SENTINEL, usage: undefined };
      return {
        content: validGrounded,
        toolCalls: [
          {
            id: 'c1',
            type: 'function' as const,
            function: { name: 'srv__do_thing', arguments: '{}' },
          },
        ],
        usage: undefined,
      };
    });
    const mcp = { toolSet: new McpToolSet(connect), store: memoryStore(new Map([['srv', STDIO]])) };
    const { finished, text } = driveInteractive(
      client,
      ['какие профили сканирования есть?', '/exit'],
      0.7,
      undefined,
      true,
      null,
      { ...makeSession(), ragSources: ['/docs'] },
      'window',
      6,
      undefined,
      mcp,
    );
    await finished;
    assert.ok(called.some(c => c.endsWith('search_docs'))); // форс-поиск вызван
    assert.ok(!called.some(c => c.endsWith('do_thing'))); // посторонний инструмент НЕ вызван
    assert.match(text(), /find_places ищет организации рядом/); // ответ синтезирован из фрагментов
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

  it('grounded-режим: содержательный вопрос → принудительный поиск по источникам + гейт', async t => {
    const searchResult =
      'Найдено фрагментов: 1 по запросу «q»:\n' +
      '🔎 кандидатов 1 → rerank(none): 1 · уверенность 0.80\n\n' +
      '[1] doc#0 · /docs › doc.md › Раздел (0.800)\n' +
      'find_places ищет организации рядом';
    const valid =
      'Ответ: find_places.\nИсточники:\n- /docs › doc.md · doc#0\n' +
      'Цитаты:\n- find_places ищет организации рядом';
    let searchCalls = 0;
    const connect: ConnectFn = async name => ({
      name,
      tools: () => [{ name: 'search_docs', description: 'RAG', parameters: { type: 'object' } }],
      call: async () => {
        searchCalls++;
        return searchResult;
      },
      close: async () => {},
    });
    // Модель отвечает сразу (фрагменты уже в контексте из принудительного поиска) — без tool_call.
    const client = clientWith(t, async () => ({ content: valid, usage: undefined }));
    const mcp = { toolSet: new McpToolSet(connect), store: memoryStore(new Map([['rag', STDIO]])) };
    const session = { ...makeSession(), ragSources: ['/docs'] };
    const { finished, text } = driveInteractive(
      client,
      ['как искать места рядом?', '/exit'],
      0.7,
      undefined,
      true,
      null,
      session,
      'window',
      6,
      undefined,
      mcp,
    );
    await finished;
    const out = text();
    assert.equal(searchCalls, 1); // принудительный поиск по единственному источнику
    assert.match(out, /🔎 RAG-поиск/); // сводка поиска показана
    assert.match(out, /find_places ищет организации рядом/); // ответ с цитатой прошёл гейт
  });

  it('RAG_QUIET=1: логи поиска (🔎/🔧 search) скрыты, ответ с источниками остаётся', async t => {
    const searchResult =
      'Найдено фрагментов: 1 по запросу «q»:\n' +
      '🔎 кандидатов 1 → rerank(none): 1 · уверенность 0.80\n\n' +
      '[1] doc#0 · /docs › doc.md › Раздел (0.800)\n' +
      'find_places ищет организации рядом';
    const valid =
      'Ответ: find_places.\nИсточники:\n- /docs › doc.md · doc#0\n' +
      'Цитаты:\n- find_places ищет организации рядом';
    const connect: ConnectFn = async name => ({
      name,
      tools: () => [{ name: 'search_docs', description: 'RAG', parameters: { type: 'object' } }],
      call: async () => searchResult,
      close: async () => {},
    });
    const client = clientWith(t, async () => ({ content: valid, usage: undefined }));
    const mcp = { toolSet: new McpToolSet(connect), store: memoryStore(new Map([['rag', STDIO]])) };
    const session = { ...makeSession(), ragSources: ['/docs'] };
    const previous = process.env.RAG_QUIET;
    process.env.RAG_QUIET = '1';
    try {
      const { finished, text } = driveInteractive(
        client,
        ['как искать места рядом?', '/exit'],
        0.7,
        undefined,
        true,
        null,
        session,
        'window',
        6,
        undefined,
        mcp,
      );
      await finished;
      const out = text();
      assert.doesNotMatch(out, /🔎 RAG-поиск/); // сводка поиска скрыта
      assert.doesNotMatch(out, /🔧 инструмент rag__search_docs/); // вызов поиска скрыт
      assert.match(out, /find_places ищет организации рядом/); // ответ с цитатой показан
    } finally {
      if (previous === undefined) delete process.env.RAG_QUIET;
      else process.env.RAG_QUIET = previous;
    }
  });

  it('grounded-режим: разговорная реплика («спасибо») → без RAG-поиска, обычный ответ', async t => {
    let searchCalls = 0;
    const connect: ConnectFn = async name => ({
      name,
      tools: () => [{ name: 'search_docs', description: 'RAG', parameters: { type: 'object' } }],
      call: async () => {
        searchCalls++;
        return 'НЕ ДОЛЖНО ВЫЗЫВАТЬСЯ';
      },
      close: async () => {},
    });
    const client = clientWith(t, async () => ({ content: 'Пожалуйста!', usage: undefined }));
    const mcp = { toolSet: new McpToolSet(connect), store: memoryStore(new Map([['rag', STDIO]])) };
    const session = { ...makeSession(), ragSources: ['/docs'] };
    const { finished, text } = driveInteractive(
      client,
      ['спасибо', '/exit'],
      0.7,
      undefined,
      true,
      null,
      session,
      'window',
      6,
      undefined,
      mcp,
    );
    await finished;
    const out = text();
    assert.equal(searchCalls, 0); // разговорную реплику не ищем
    assert.doesNotMatch(out, /🔎 RAG-поиск/);
    assert.match(out, /Пожалуйста/);
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
