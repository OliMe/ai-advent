import type { ToolSet, ToolSpec } from '../../core/src/index.ts';
import type { McpServerConfig } from './config.ts';

/** Подключение к одному MCP-серверу — минимальный контракт для агрегатора (тестируемо). */
export interface McpConnection {
  readonly name: string;
  /** Инструменты сервера (получены при подключении). */
  tools(): ToolSpec[];
  /** Вызывает инструмент сервера и возвращает текстовый результат. */
  call(toolName: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

/** Фабрика подключения к серверу: реальная — поверх SDK, в тестах — фейк. */
export type ConnectFn = (name: string, config: McpServerConfig) => Promise<McpConnection>;

/** Разделитель неймспейса инструмента: «сервер__инструмент». */
const NAMESPACE_SEPARATOR = '__';

/**
 * Агрегирует инструменты нескольких MCP-серверов в единый ToolSet ядра. Поддерживает
 * рантайм add/remove; инструменты неймспейсятся как «сервер__инструмент» (от коллизий имён).
 */
export class McpToolSet implements ToolSet {
  private readonly connect: ConnectFn;
  private readonly connections = new Map<string, McpConnection>();

  constructor(connect: ConnectFn) {
    this.connect = connect;
  }

  /** Подключает (или переподключает) сервер; возвращает число его инструментов. */
  async addServer(name: string, config: McpServerConfig): Promise<number> {
    await this.removeServer(name); // переподключение, если сервер уже был
    const connection = await this.connect(name, config);
    this.connections.set(name, connection);
    return connection.tools().length;
  }

  /** Отключает сервер; true — если он был подключён. */
  async removeServer(name: string): Promise<boolean> {
    const connection = this.connections.get(name);
    if (connection === undefined) {
      return false;
    }
    await connection.close();
    this.connections.delete(name);
    return true;
  }

  /** Имена подключённых серверов. */
  serverNames(): string[] {
    return [...this.connections.keys()];
  }

  specs(): ToolSpec[] {
    const specs: ToolSpec[] = [];
    for (const [name, connection] of this.connections) {
      for (const spec of connection.tools()) {
        specs.push({
          name: `${name}${NAMESPACE_SEPARATOR}${spec.name}`,
          description: spec.description,
          parameters: spec.parameters,
        });
      }
    }
    return specs;
  }

  async call(qualifiedName: string, args: Record<string, unknown>): Promise<string> {
    const separator = qualifiedName.indexOf(NAMESPACE_SEPARATOR);
    if (separator === -1) {
      throw new Error(`Инструмент без неймспейса сервера: ${qualifiedName}`);
    }
    const serverName = qualifiedName.slice(0, separator);
    const toolName = qualifiedName.slice(separator + NAMESPACE_SEPARATOR.length);
    const connection = this.connections.get(serverName);
    if (connection === undefined) {
      throw new Error(`MCP-сервер не подключён: ${serverName}`);
    }
    return connection.call(toolName, args);
  }

  /** Закрывает все подключения. */
  async close(): Promise<void> {
    for (const connection of this.connections.values()) {
      await connection.close();
    }
    this.connections.clear();
  }
}
