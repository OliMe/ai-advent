import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';
import { driveInteractive, clientWith } from './helpers.ts';
import { McpToolSet } from '../../../mcp-client/src/index.ts';
import type { ConnectFn, McpServerConfig } from '../../../mcp-client/src/index.ts';
import type { McpStore, ClipboardImageReader } from '../index.ts';
import { makeConfig } from '../../../core/src/__test__/helpers.ts';

const STDIO: McpServerConfig = { transport: 'stdio', command: 'x', args: [] };

function memoryStore(initial: Map<string, McpServerConfig>): McpStore {
  let servers = new Map(initial);
  return {
    load: () => new Map(servers),
    save: updated => {
      servers = new Map(updated);
    },
  };
}

describe('интерактив — распознавание локального файла', () => {
  it('путь из текста: файл читается на стороне CLI и уходит серверу как base64', async t => {
    const imagePath = join(tmpdir(), `recognize-flow-${process.pid}.png`);
    writeFileSync(imagePath, 'PNGДАННЫЕ');
    let received: Record<string, unknown> | null = null;
    const connect: ConnectFn = async name => ({
      name,
      tools: () => [{ name: 'recognize-text', description: 'OCR', parameters: { type: 'object' } }],
      call: async (_tool, args) => {
        received = args;
        return 'AI ADVENT 2026';
      },
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
                function: {
                  name: 'srv__recognize-text',
                  arguments: `{"path":${JSON.stringify(imagePath)}}`,
                },
              },
            ],
            usage: undefined,
          }
        : { content: 'Распознано: AI ADVENT 2026', usage: undefined };
    });
    const mcp = { toolSet: new McpToolSet(connect), store: memoryStore(new Map([['srv', STDIO]])) };
    try {
      const { finished, text } = driveInteractive(
        client,
        [`распознай ${imagePath}`, '/exit'],
        0.7,
        makeConfig(),
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
      assert.match(out, /🔍 Читаю текст с картинок…/); // дружелюбная строка, без пути
      assert.doesNotMatch(out, /yandex__recognize-text \{/); // технический лог не печатается
      assert.match(out, /Распознано: AI ADVENT 2026/);
    } finally {
      rmSync(imagePath, { force: true });
    }
    // Сервер получил base64 вместо path (локальный файл прочитан на стороне CLI).
    assert.equal(received!.path, undefined);
    assert.equal(received!.base64, Buffer.from('PNGДАННЫЕ').toString('base64'));
    assert.equal(received!.mimeType, 'image/png');
  });

  it('передан читатель буфера (Ctrl+V) — перехват ставится без ошибок', async t => {
    const client = clientWith(t, async () => ({ content: 'ок', usage: undefined }));
    const clipboard: ClipboardImageReader = { read: () => null };
    const { finished, text } = driveInteractive(
      client,
      ['/exit'],
      0.7,
      makeConfig(),
      true,
      null,
      undefined,
      'window',
      6,
      undefined,
      null,
      clipboard,
    );
    await finished;
    assert.match(text(), /До встречи/);
  });

  it('«фантомное» заявление действия без вызова инструмента → предупреждение', async t => {
    // Модель «рапортует» о созданном напоминании, не вызвав schedule_task.
    const client = clientWith(t, async () => ({
      content: 'Создал два напоминания про Костю.',
      usage: undefined,
    }));
    const mcp = {
      toolSet: new McpToolSet(async () => ({
        name: 'n',
        tools: () => [],
        call: async () => '',
        close: async () => {},
      })),
      store: memoryStore(new Map()),
    };
    const { finished, text } = driveInteractive(
      client,
      ['напомни про Костю', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
      undefined,
      'window',
      6,
      undefined,
      mcp,
    );
    await finished;
    assert.match(text(), /⚠ Похоже, ассистент сообщил о действии в планировщике/);
  });

  it('MCP включён без серверов → агентный путь (доступен только get_my_location)', async t => {
    // С подключённым MCP набор инструментов непуст всегда (клиентский get_my_location),
    // поэтому идём агентным циклом; модель не вызывает инструмент и сразу отвечает.
    const client = clientWith(t, async () => ({ content: 'обычный ответ', usage: undefined }));
    const mcp = {
      toolSet: new McpToolSet(async () => ({
        name: 'n',
        tools: () => [],
        call: async () => '',
        close: async () => {},
      })),
      store: memoryStore(new Map()),
    };
    const { finished, text } = driveInteractive(
      client,
      ['привет', '/exit'],
      0.7,
      makeConfig(),
      true,
      null,
      undefined,
      'window',
      6,
      undefined,
      mcp,
    );
    await finished;
    assert.match(text(), /обычный ответ/);
  });
});
