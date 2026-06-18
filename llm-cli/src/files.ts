import { readFileSync } from 'node:fs';

/** Читает текстовый файл или бросает понятную ошибку. */
export function readFileContent(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Не удалось прочитать файл: ${path}`);
  }
}

/** Оформляет содержимое файла для вставки в запрос (с пометкой и кодовым блоком). */
export function formatAttachment(path: string, content: string): string {
  return `Содержимое файла «${path}»:\n\`\`\`\n${content}\n\`\`\``;
}

/** Читает файлы и собирает их оформленное содержимое в один блок. */
export function attachFiles(paths: string[]): string {
  return paths.map(path => formatAttachment(path, readFileContent(path))).join('\n\n');
}

/** Объединяет вложения файлов и текст промпта в одно сообщение. */
export function combinePrompt(attachments: string, prompt: string): string {
  return attachments && prompt ? `${attachments}\n\n${prompt}` : attachments || prompt;
}
