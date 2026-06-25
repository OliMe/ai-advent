/**
 * Сборка MCP-сервера: регистрирует инструмент recognize-text и связывает его с реальными
 * зависимостями (чтение файла, загрузка по URL, fetch к Yandex). Только проводка — логика в
 * модулях (config/image-source/yandex-ocr/recognize-tool), поэтому файл исключён из покрытия.
 */
import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OcrConfig } from './config.ts';
import type { ImageReaders } from './image-source.ts';
import type { RequestCounter } from './request-counter.ts';
import { runRecognizeText } from './recognize-tool.ts';

/** Реальные читатели изображения: локальный файл и загрузка по URL. */
function realReaders(): ImageReaders {
  return {
    readFile: path => readFile(path),
    fetchUrl: async url => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Не удалось скачать изображение: HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      return { buffer, contentType: response.headers.get('content-type') ?? undefined };
    },
  };
}

/** Создаёт MCP-сервер Yandex OCR с зарегистрированным инструментом recognize-text. */
export function createServer(config: OcrConfig, counter?: RequestCounter): McpServer {
  const server = new McpServer({ name: 'yandex-ocr-mcp', version: '1.0.0' });
  const deps = { config, readers: realReaders(), fetchFn: fetch };
  server.registerTool(
    'recognize-text',
    {
      title: 'Распознать текст (Yandex OCR)',
      description:
        'Распознаёт текст на изображении или странице через Yandex Vision OCR. Источник — ' +
        'локальный файл (path), ссылка (url) или содержимое в base64. Возвращает распознанный текст.',
      inputSchema: {
        path: z.string().optional(),
        url: z.string().optional(),
        base64: z.string().optional(),
        mimeType: z.string().optional(),
        languageCodes: z.array(z.string()).optional(),
        model: z.string().optional(),
      },
    },
    async args => {
      counter?.increment();
      const result = await runRecognizeText(deps, args);
      return { content: result.content };
    },
  );
  return server;
}
