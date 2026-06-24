/** Источник изображения для распознавания: ровно один из path/url/base64 + опц. mimeType. */
export interface ImageInput {
  path?: string;
  url?: string;
  base64?: string;
  mimeType?: string;
}

/** Изображение, подготовленное к отправке в OCR: содержимое в base64 и его MIME-тип. */
export interface ResolvedImage {
  content: string;
  mimeType: string;
}

/** Чтение файла и загрузка по URL — инжектируются (чтобы логику можно было тестировать). */
export interface ImageReaders {
  readFile: (path: string) => Promise<Buffer>;
  fetchUrl: (url: string) => Promise<{ buffer: Buffer; contentType?: string }>;
}

const DEFAULT_MIME_TYPE = 'image/jpeg';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
};

/** MIME-тип по расширению имени/URL (или undefined, если расширение неизвестно). */
export function inferMimeType(name: string): string | undefined {
  const match = name.toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? MIME_BY_EXTENSION[match[0]] : undefined;
}

/** Бросает ошибку, если задано больше одного источника изображения. */
function rejectMultipleSources(input: ImageInput): void {
  const count = [input.path, input.url, input.base64].filter(value => value !== undefined).length;
  if (count > 1) {
    throw new Error('Задайте только один источник изображения: path, url или base64.');
  }
}

/** Готовит изображение к распознаванию: читает источник и определяет MIME-тип. */
export async function resolveImage(
  input: ImageInput,
  readers: ImageReaders,
): Promise<ResolvedImage> {
  if (input.path !== undefined) {
    rejectMultipleSources(input);
    const buffer = await readers.readFile(input.path);
    return {
      content: buffer.toString('base64'),
      mimeType: input.mimeType ?? inferMimeType(input.path) ?? DEFAULT_MIME_TYPE,
    };
  }
  if (input.url !== undefined) {
    rejectMultipleSources(input);
    const { buffer, contentType } = await readers.fetchUrl(input.url);
    return {
      content: buffer.toString('base64'),
      mimeType: input.mimeType ?? inferMimeType(input.url) ?? contentType ?? DEFAULT_MIME_TYPE,
    };
  }
  if (input.base64 !== undefined) {
    rejectMultipleSources(input);
    return { content: input.base64, mimeType: input.mimeType ?? DEFAULT_MIME_TYPE };
  }
  throw new Error('Не задан источник изображения: укажите path, url или base64.');
}
