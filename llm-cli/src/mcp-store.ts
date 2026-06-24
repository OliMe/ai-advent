import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseServers } from '../../mcp-client/src/index.ts';
import type { McpServerConfig } from '../../mcp-client/src/index.ts';

/** Хранилище конфигурации MCP-серверов (карта имя → конфиг). */
export interface McpStore {
  load(): Map<string, McpServerConfig>;
  save(servers: Map<string, McpServerConfig>): void;
}

/** Разбирает «команда [аргументы] | URL» из команды `/mcp add` в конфиг сервера. */
export function parseServerSpec(tokens: string[]): McpServerConfig {
  const [first, ...rest] = tokens;
  if (first === undefined || first === '') {
    throw new Error('Укажите команду запуска (stdio) или URL (http) сервера.');
  }
  if (/^https?:\/\//.test(first)) {
    return { transport: 'http', url: first };
  }
  return { transport: 'stdio', command: first, args: rest };
}

/** Сериализует конфиг сервера обратно в запись mcpServers. */
function toEntry(config: McpServerConfig): Record<string, unknown> {
  return config.transport === 'http'
    ? { url: config.url, ...(config.headers ? { headers: config.headers } : {}) }
    : { command: config.command, args: config.args, ...(config.env ? { env: config.env } : {}) };
}

/** Файловое хранилище конфигурации MCP-серверов (`~/.llm-cli/mcp.json`), атомарная запись. */
export class FileMcpStore implements McpStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  load(): Map<string, McpServerConfig> {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return new Map(); // файла нет — пустая конфигурация
    }
    try {
      return parseServers(JSON.parse(raw));
    } catch {
      return new Map(); // битый JSON — считаем конфигурацию пустой
    }
  }

  save(servers: Map<string, McpServerConfig>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const mcpServers: Record<string, unknown> = {};
    for (const [name, config] of servers) {
      mcpServers[name] = toEntry(config);
    }
    const temporaryPath = `${this.path}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, this.path);
  }
}
