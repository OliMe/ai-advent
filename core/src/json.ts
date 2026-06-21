// Ленивый разбор JSON из ответа модели: JSON просим в промпте (без response_format,
// иначе z.ai/GLM вырезает литерал «json»), а ответ может прийти в обёртке прозой.

/** Извлекает первый сбалансированный объект `{…}` из текста (учёт строк и экранирования). */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
    } else if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth++;
    } else if (character === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null; // незакрытый объект
}

/** Парсит JSON-объект из ответа: целиком, иначе первый блок `{…}` в прозе; иначе null. */
export function parseJsonObject(content: string): Record<string, unknown> | null {
  for (const candidate of [content, extractJsonObject(content)]) {
    if (candidate === null) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // пробуем следующий кандидат
    }
  }
  return null;
}
