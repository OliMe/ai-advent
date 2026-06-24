import type { OcrConfig } from './config.ts';
import type { ImageReaders } from './image-source.ts';
import { resolveImage } from './image-source.ts';
import type { FetchLike } from './yandex-ocr.ts';
import { recognizeText } from './yandex-ocr.ts';

/** Зависимости инструмента распознавания (инжектируются — реальные в сервере, фейковые в тестах). */
export interface RecognizeDeps {
  config: OcrConfig;
  readers: ImageReaders;
  fetchFn: FetchLike;
}

/** Аргументы вызова инструмента recognize-text. */
export interface RecognizeArgs {
  path?: string;
  url?: string;
  base64?: string;
  mimeType?: string;
  languageCodes?: string[];
  model?: string;
}

/** Результат инструмента в формате MCP (текстовый блок). */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
}

/** Распознаёт текст: резолвит источник изображения, зовёт OCR, отдаёт текст MCP-ответом. */
export async function runRecognizeText(
  deps: RecognizeDeps,
  args: RecognizeArgs,
): Promise<ToolResult> {
  const image = await resolveImage(args, deps.readers);
  const result = await recognizeText(deps.fetchFn, deps.config, {
    content: image.content,
    mimeType: image.mimeType,
    languageCodes: args.languageCodes ?? deps.config.languageCodes,
    model: args.model ?? deps.config.model,
  });
  return { content: [{ type: 'text', text: result.fullText }] };
}
