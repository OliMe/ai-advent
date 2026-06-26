/**
 * Сборка MCP-сервера файловой системы: регистрирует инструменты чтения/записи/списка/удаления,
 * связанные с allow-list и реальными ФС-операциями. Только проводка к SDK — логика в
 * sandbox/operations/tools, поэтому файл исключён из покрытия.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolDeps } from './tools.ts';
import {
  handleReadFile,
  handleWriteFile,
  handleAppendFile,
  handleListDir,
  handleDeletePath,
} from './tools.ts';

/** Оборачивает текст в ответ MCP-инструмента. */
function text(value: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: value }] };
}

/** Создаёт MCP-сервер файловой системы с allow-list из deps. */
export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: 'filesystem-mcp', version: '1.0.0' });
  const allowed = deps.allowedDirs.join(', ');

  server.registerTool(
    'read_file',
    {
      title: 'Прочитать файл',
      description: `Читает текстовый файл. Разрешённые каталоги: ${allowed}.`,
      inputSchema: { path: z.string() },
    },
    async args => text(handleReadFile(deps, args)),
  );

  server.registerTool(
    'write_file',
    {
      title: 'Записать файл',
      description: `Создаёт или перезаписывает файл (родительские папки создаются). Разрешено: ${allowed}.`,
      inputSchema: { path: z.string(), content: z.string() },
    },
    async args => text(handleWriteFile(deps, args)),
  );

  server.registerTool(
    'append_file',
    {
      title: 'Дописать в файл',
      description: `Дописывает текст в конец файла (создаёт, если нет). Разрешено: ${allowed}.`,
      inputSchema: { path: z.string(), content: z.string() },
    },
    async args => text(handleAppendFile(deps, args)),
  );

  server.registerTool(
    'list_dir',
    {
      title: 'Список каталога',
      description: `Перечисляет файлы и папки в каталоге (по умолчанию — корень allow-list).`,
      inputSchema: { path: z.string().optional() },
    },
    async args => text(handleListDir(deps, args)),
  );

  server.registerTool(
    'delete_path',
    {
      title: 'Удалить файл/пустую папку',
      description:
        'Удаляет ОДИНОЧНЫЙ файл или ПУСТУЮ папку. Рекурсивного удаления нет; корень allow-list ' +
        'удалить нельзя.',
      inputSchema: { path: z.string() },
    },
    async args => text(handleDeletePath(deps, args)),
  );

  return server;
}
