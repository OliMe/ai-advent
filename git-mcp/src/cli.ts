/**
 * Точка входа MCP-сервера git (stdio): разрешённые репозитории — из аргументов командной строки
 * (или GIT_ALLOWED_REPOS) плюс корень репозитория рабочего каталога. Только проводка — вне покрытия.
 * В stdout идёт протокол MCP, поэтому диагностику пишем в stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync } from 'node:fs';
import { loadAllowedRepos, loadMaxOutputChars, workingRepositoryRoot } from './config.ts';
import { nodeGitIo } from './operations.ts';
import { createServer } from './server.ts';

async function main(): Promise<void> {
  // Разрешаем КОРЕНЬ репозитория рабочего каталога: клиент запускается из своего пакета,
  // а проект — это репозиторий над ним.
  const allowedRepos = loadAllowedRepos(
    process.argv.slice(2),
    process.env,
    workingRepositoryRoot(process.cwd(), existsSync),
  );
  const maxOutputChars = loadMaxOutputChars(process.env);
  const server = createServer({ io: nodeGitIo, allowedRepos, maxOutputChars });
  console.error(`git-mcp: разрешённые репозитории — ${allowedRepos.join(', ')}`);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
