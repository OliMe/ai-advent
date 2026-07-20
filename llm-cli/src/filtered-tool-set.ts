import type { ToolSet, ToolSpec } from '../../core/src/index.ts';

/** Разделитель неймспейса MCP: инструменты приходят как `сервер__инструмент`. */
const NAMESPACE_SEPARATOR = '__';

/** Имя MCP-сервера из имени инструмента (`git__read_file` → `git`); без неймспейса → ''. */
function serverOf(toolName: string): string {
  const index = toolName.indexOf(NAMESPACE_SEPARATOR);
  return index >= 0 ? toolName.slice(0, index) : '';
}

/**
 * Предикат «инструмент принадлежит одному из разрешённых серверов» (по неймспейсу). Инструменты без
 * неймспейса (чисто клиентские, напр. `get_my_location`) не проходят — этапам пайплайна они не нужны.
 */
export function serverScopePredicate(allowedServers: readonly string[]): (name: string) => boolean {
  const allowed = new Set(allowedServers);
  return name => allowed.has(serverOf(name));
}

/**
 * Декоратор набора инструментов: показывает и исполняет ТОЛЬКО те, чьё имя проходит предикат. Остальные
 * скрыты (нет в `specs`) и на прямой вызов отвечают отказом. Нужен, чтобы сузить набор для этапов
 * пайплайна (меньше схем в каждом раунде = экономия токенов; нет посторонних серверов = меньше
 * overreach), НЕ трогая исходный набор — его продолжает видеть чат. Делегирует живому `inner`, поэтому
 * `/mcp add`/`remove` в рантайме отражаются автоматически.
 */
export class FilteredToolSet implements ToolSet {
  private readonly inner: ToolSet;
  private readonly allow: (name: string) => boolean;

  constructor(inner: ToolSet, allow: (name: string) => boolean) {
    this.inner = inner;
    this.allow = allow;
  }

  specs(): ToolSpec[] {
    return this.inner.specs().filter(spec => this.allow(spec.name));
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.allow(name)) {
      return `Инструмент недоступен на этом этапе: ${name}`;
    }
    return this.inner.call(name, args);
  }
}

/**
 * Возвращает набор инструментов для ЭТАПОВ ПАЙПЛАЙНА: при заданном списке серверов — только их
 * инструменты (`FilteredToolSet`), иначе исходный набор без изменений. Нет инструментов → undefined.
 * Вынесено чистой функцией, чтобы решение о скоупе покрывалось юнит-тестами, а место вызова осталось
 * без ветвлений.
 */
export function scopePipelineTools(
  tools: ToolSet | null | undefined,
  allowedServers: string[] | undefined,
): ToolSet | undefined {
  if (!tools) {
    return undefined;
  }
  if (allowedServers === undefined || allowedServers.length === 0) {
    return tools;
  }
  return new FilteredToolSet(tools, serverScopePredicate(allowedServers));
}
