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

/**
 * Запрос подтверждения у клиента через MCP elicitation: путь вне песочницы разрешается, только
 * если пользователь ответил «accept». Клиент без поддержки elicitation (или ошибка) → отказ.
 */
function elicitConfirm(server: McpServer): (message: string) => Promise<boolean> {
  return async message => {
    try {
      const result = await server.server.elicitInput({
        mode: 'form',
        message,
        requestedSchema: { type: 'object', properties: {} },
      });
      return result.action === 'accept';
    } catch {
      return false;
    }
  };
}

/** Создаёт MCP-сервер файловой системы с allow-list из deps. */
export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: 'filesystem-mcp', version: '1.0.0' });
  const allowed = deps.allowedDirs.join(', ');
  // Подтверждение для путей вне песочницы: если извне не задано — спрашиваем клиента (elicitation).
  const withConfirm: ToolDeps = { ...deps, confirm: deps.confirm ?? elicitConfirm(server) };
  // Пояснение про песочницу для модели: путь вне разрешённых каталогов НЕ запрещён — выполняй
  // вызов как обычно, у пользователя спросят подтверждение. Не отказывай заранее.
  const outsideNote = `Без подтверждения разрешены каталоги: ${allowed}. Путь вне них тоже можно — НЕ отказывай заранее, вызывай инструмент: пользователь подтвердит операцию.`;

  server.registerTool(
    'read_file',
    {
      title: 'Прочитать файл',
      description: `Читает текстовый файл. ${outsideNote}`,
      inputSchema: { path: z.string() },
    },
    async args => text(await handleReadFile(withConfirm, args)),
  );

  server.registerTool(
    'write_file',
    {
      title: 'Записать файл',
      description: `Создаёт или перезаписывает файл (родительские папки создаются). ${outsideNote}`,
      inputSchema: { path: z.string(), content: z.string() },
    },
    async args => text(await handleWriteFile(withConfirm, args)),
  );

  server.registerTool(
    'append_file',
    {
      title: 'Дописать в файл',
      description: `Дописывает текст в конец файла (создаёт, если нет). ${outsideNote}`,
      inputSchema: { path: z.string(), content: z.string() },
    },
    async args => text(await handleAppendFile(withConfirm, args)),
  );

  server.registerTool(
    'list_dir',
    {
      title: 'Список каталога',
      description: `Перечисляет файлы и папки в каталоге (по умолчанию — корень allow-list). ${outsideNote}`,
      inputSchema: { path: z.string().optional() },
    },
    async args => text(await handleListDir(withConfirm, args)),
  );

  server.registerTool(
    'delete_path',
    {
      title: 'Удалить файл/пустую папку',
      description:
        'Удаляет ОДИНОЧНЫЙ файл или ПУСТУЮ папку. Рекурсивного удаления нет; корень allow-list ' +
        `удалить нельзя. ${outsideNote}`,
      inputSchema: { path: z.string() },
    },
    async args => text(await handleDeletePath(withConfirm, args)),
  );

  return server;
}
