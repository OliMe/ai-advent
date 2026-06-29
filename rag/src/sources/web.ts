import type { Document } from '../types.ts';

/** Загрузчик HTML по URL (инжектируется); null — страницу не удалось получить. */
export type FetchText = (url: string) => Promise<string | null>;

/** Грубое извлечение читаемого текста из HTML: убрать script/style, теги, схлопнуть пробелы. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Заголовок страницы из `<title>` или пустая строка. */
export function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? match[1].trim() : '';
}

/** Ссылки того же origin (для обхода в пределах сайта), абсолютные и без якоря. */
export function extractLinks(html: string, base: string): string[] {
  const links = new Set<string>();
  const origin = new URL(base).origin;
  const pattern = /<a\s[^>]*href=["']([^"'#]+)["']/gi;
  let match = pattern.exec(html);
  while (match !== null) {
    try {
      const url = new URL(match[1], base);
      if (url.origin === origin) {
        url.hash = '';
        links.add(url.toString());
      }
    } catch {
      // битая ссылка — пропускаем
    }
    match = pattern.exec(html);
  }
  return [...links];
}

/**
 * Обход сайта в ширину от стартового URL до заданной глубины (в пределах origin), с дедупликацией.
 * Каждая успешно полученная страница → документ (заголовок + текст). Логика чистая: загрузка
 * инжектируется через fetchText.
 */
export async function crawlWeb(
  startUrl: string,
  depth: number,
  fetchText: FetchText,
): Promise<Document[]> {
  const visited = new Set<string>();
  const documents: Document[] = [];
  let frontier = [startUrl];
  for (let level = 0; level <= depth; level++) {
    const next: string[] = [];
    for (const url of frontier) {
      if (visited.has(url)) {
        continue;
      }
      visited.add(url);
      const html = await fetchText(url);
      if (html === null) {
        continue;
      }
      documents.push({
        source: startUrl,
        file: url,
        title: extractTitle(html) || url,
        text: htmlToText(html),
      });
      if (level < depth) {
        next.push(...extractLinks(html, url).filter(link => !visited.has(link)));
      }
    }
    frontier = next;
  }
  return documents;
}
