import type { ToolSpec } from '../../core/src/index.ts';

/** Безопасно достаёт поле объекта (или undefined для не-объектов). */
function pick(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Строковое поле объекта (или undefined). */
function pickString(value: unknown, key: string): string | undefined {
  const field = pick(value, key);
  return typeof field === 'string' ? field : undefined;
}

/** Преобразует список инструментов MCP-сервера (`tools/list`) в ToolSpec ядра. */
export function toToolSpecs(rawTools: unknown): ToolSpec[] {
  if (!Array.isArray(rawTools)) {
    return [];
  }
  return rawTools.flatMap(raw => {
    const name = pickString(raw, 'name');
    if (name === undefined) {
      return [];
    }
    const schema = pick(raw, 'inputSchema');
    return [
      {
        name,
        description: pickString(raw, 'description') ?? '',
        parameters:
          typeof schema === 'object' && schema !== null ? (schema as Record<string, unknown>) : {},
      },
    ];
  });
}

/** Извлекает текст из результата вызова инструмента MCP (текстовые блоки content). */
export function extractToolText(result: unknown): string {
  const content = pick(result, 'content');
  const text = Array.isArray(content)
    ? content
        .map(block =>
          pickString(block, 'type') === 'text' ? (pickString(block, 'text') ?? '') : '',
        )
        .filter(Boolean)
        .join('\n')
    : '';
  return pick(result, 'isError') === true ? `Инструмент вернул ошибку: ${text}` : text;
}
