/**
 * Сборка MCP-сервера git: регистрирует инструменты чтения репозитория. Только проводка к SDK —
 * логика в sandbox/operations/tools, поэтому файл исключён из покрытия.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolDeps } from './tools.ts';
import {
  handleGitBranch,
  handleGitStatus,
  handleGitListFiles,
  handleGitLog,
  handleGitDiff,
  handleGitGrep,
  handleReadFile,
} from './tools.ts';

/** Оборачивает текст в ответ MCP-инструмента. */
function text(value: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: value }] };
}

/**
 * Запрос подтверждения у клиента через MCP elicitation: репозиторий вне песочницы читается, только
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

/** Создаёт MCP-сервер git с allow-list из deps. */
export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: 'git-mcp', version: '1.0.0' });
  const withConfirm: ToolDeps = { ...deps, confirm: deps.confirm ?? elicitConfirm(server) };
  const defaultRepo = deps.allowedRepos[0];
  // Пояснение для модели: repo — необязателен (дефолт ниже), а репозиторий вне allow-list НЕ
  // запрещён — вызывай инструмент, у пользователя спросят подтверждение.
  const repoNote =
    `Аргумент repo — путь к репозиторию; без него берётся ${defaultRepo}. При нескольких ` +
    'привязанных проектах указывай repo ЯВНО. Репозиторий вне разрешённых каталогов тоже можно — ' +
    'НЕ отказывай заранее, вызывай инструмент: пользователь подтвердит операцию.';

  server.registerTool(
    'git_branch',
    {
      title: 'Текущая ветка',
      description: `Текущая ветка репозитория (или отделённый HEAD). ${repoNote}`,
      inputSchema: { repo: z.string().optional() },
    },
    async args => text(await handleGitBranch(withConfirm, args)),
  );

  server.registerTool(
    'git_status',
    {
      title: 'Статус репозитория',
      description: `Изменённые и неотслеживаемые файлы (короткий статус). ${repoNote}`,
      inputSchema: { repo: z.string().optional() },
    },
    async args => text(await handleGitStatus(withConfirm, args)),
  );

  server.registerTool(
    'git_list_files',
    {
      title: 'Файлы репозитория',
      description:
        'Отслеживаемые файлы репозитория; subdir ограничивает подкаталогом. Так узнают ' +
        `структуру проекта. ${repoNote}`,
      inputSchema: { repo: z.string().optional(), subdir: z.string().optional() },
    },
    async args => text(await handleGitListFiles(withConfirm, args)),
  );

  server.registerTool(
    'git_log',
    {
      title: 'История коммитов',
      description: `Последние коммиты (limit — сколько, по умолчанию 10). ${repoNote}`,
      inputSchema: { repo: z.string().optional(), limit: z.number().optional() },
    },
    async args => text(await handleGitLog(withConfirm, args)),
  );

  server.registerTool(
    'git_diff',
    {
      title: 'Изменения',
      description:
        'Незакоммиченные изменения: рабочее дерево, а при staged=true — индекс; path сужает до ' +
        `файла. Длинный вывод усекается. ${repoNote}`,
      inputSchema: {
        repo: z.string().optional(),
        path: z.string().optional(),
        staged: z.boolean().optional(),
      },
    },
    async args => text(await handleGitDiff(withConfirm, args)),
  );

  server.registerTool(
    'git_grep',
    {
      title: 'Поиск по коду',
      description:
        'Точный поиск (git grep) по отслеживаемым файлам: pattern — что искать, subdir — где. ' +
        `Так находят место в КОДЕ, которого нет в документации. ${repoNote}`,
      inputSchema: {
        repo: z.string().optional(),
        pattern: z.string(),
        subdir: z.string().optional(),
      },
    },
    async args => text(await handleGitGrep(withConfirm, args)),
  );

  server.registerTool(
    'read_file',
    {
      title: 'Прочитать файл проекта',
      description:
        'Читает файл рабочего дерева репозитория (path — относительно корня репозитория). ' +
        `Длинный файл усекается. ${repoNote}`,
      inputSchema: { repo: z.string().optional(), path: z.string() },
    },
    async args => text(await handleReadFile(withConfirm, args)),
  );

  return server;
}
