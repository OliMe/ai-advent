/**
 * Точка входа AI-ревью PR (тонкая проводка, вне покрытия). Собирает зависимости из окружения и
 * гоняет поток: получить изменения → обосновать (доки + код) → сгенерировать ревью → сверить с
 * реальными строками → опубликовать (или напечатать при --dry-run).
 *
 * Диагностика идёт в stderr; в stdout — итог ревью (удобно смотреть в логах Action).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  loadConfig,
  loadEmbeddingsConfig,
  ChatCompletionClient,
  EmbeddingsClient,
  discoverDocSources,
  nodeProjectIo,
} from '../../core/src/index.ts';
import { loadLocalDocuments, nodeLocalIo } from '../../rag/src/index.ts';
import type { EmbedFn } from '../../rag/src/index.ts';
import { loadReviewConfig } from './config.ts';
import { parseUnifiedDiff } from './diff.ts';
import { groundDocs, warmDocsIndex, FileIndexCache } from '../../grounding/src/index.ts';
import type { IndexCacheIo } from '../../grounding/src/index.ts';
import { readChangedFiles } from './changed-files.ts';
import { generateReview } from './review.ts';
import { validateFindings } from './validate.ts';
import { postprocessFindings } from './postprocess.ts';
import { buildPublication } from './render.ts';
import { createGithubPlatform } from './github.ts';
import type { PullChanges } from './platform.ts';

/** Флаг присутствует в argv. */
function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

/** Значение опции `--name value` или undefined. */
function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index !== -1 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, '--dry-run');
  const review = loadReviewConfig(process.env, process.cwd());

  // Эмбеддинги: нет конфига → embed бросает, groundDocs мягко деградирует на сырые доки.
  let embed: EmbedFn = async () => {
    throw new Error('эмбеддинги не настроены');
  };
  // Идентификатор схемы эмбеддинга (имя модели) — часть ключа кэша: смена модели инвалидирует индекс.
  let embeddingId = '';
  try {
    const embeddingsConfig = loadEmbeddingsConfig(process.env);
    const embeddings = new EmbeddingsClient(embeddingsConfig);
    embed = inputs => embeddings.embed(inputs);
    embeddingId = embeddingsConfig.model;
  } catch {
    console.error('эмбеддинги не настроены → RAG по докам деградирует на сырые доки');
  }

  // Файловый кэш индекса доков: собираем его ОДИН раз, дальше по неизменным докам берём готовый (на
  // CPU-эмбеддере сборка корпуса — минуты). Ключ — по содержимому доков; каталог переживает прогоны
  // CI через actions/cache (GitHub) / cache: (GitLab). Битый/отсутствующий файл → пересбор.
  const cacheIo: IndexCacheIo = {
    read(path) {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    write(path, content) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    },
  };
  const docsIndexCache = new FileIndexCache(review.cacheDir, cacheIo);

  // Прогрев кэша (фоновый пре-варм в CI по push в доки): собрать индекс доков и выйти — без обращения
  // к модели и API PR. Нужен только эмбеддер; LLM-конфиг (loadConfig ниже) здесь НЕ требуется. Так
  // даже первый PR после правки доков попадает в тёплый кэш.
  if (hasFlag(argv, '--warm-cache')) {
    const warmDocs = discoverDocSources(review.workingDir, nodeProjectIo).flatMap(source =>
      loadLocalDocuments(source, nodeLocalIo),
    );
    // Строгая сборка: ошибка/таймаут эмбеддера ПРОБРАСЫВАЕТСЯ (main().catch → exit 1 → job красный),
    // а не молча деградирует в пустой кэш.
    const chunkCount = await warmDocsIndex({
      embed,
      loadDocs: () => warmDocs,
      now: new Date().toISOString(),
      topKCount: 1,
      cache: docsIndexCache,
      embeddingId,
    });
    console.error(
      `индекс доков прогрет: ${warmDocs.length} документов, ${chunkCount} чанков → ${review.cacheDir}`,
    );
    return;
  }

  const llm = loadConfig();
  const client = new ChatCompletionClient(llm);

  // Платформа (один экземпляр на прогон): нужна для получения изменений, чтения уже оставленных
  // комментариев (идемпотентность) и публикации. В режиме --diff (локальный файл) не создаётся.
  const diffPath = optionValue(argv, '--diff');
  const platform =
    diffPath !== undefined
      ? null
      : review.platform === 'github'
        ? createGithubPlatform({
            fetchFn: globalThis.fetch as never,
            apiBaseUrl: review.apiBaseUrl,
            repo: review.repo,
            prNumber: review.prNumber,
            token: review.token,
            timeoutMs: llm.requestTimeoutMs,
            maxRetries: llm.maxRetries,
            retryBaseMs: llm.retryBaseMs,
            sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
          })
        : throwUnsupported(review.platform);

  const changes: PullChanges =
    platform === null
      ? {
          title: 'Локальный diff',
          description: '',
          files: parseUnifiedDiff(readFileSync(diffPath as string, 'utf8')),
          truncated: false,
        }
      : await platform.fetchChanges();

  if (changes.truncated) {
    console.error('⚠ Список файлов PR усечён (очень большой PR) — часть файлов не проверена.');
  }
  console.error(`файлов на ревью: ${changes.files.length}`);
  if (changes.files.length === 0) {
    console.error('нет изменённых файлов — ревью не требуется');
    return;
  }

  const docs = discoverDocSources(review.workingDir, nodeProjectIo).flatMap(source =>
    loadLocalDocuments(source, nodeLocalIo),
  );
  const docFragments = await groundDocs(
    {
      embed,
      loadDocs: () => docs,
      now: new Date().toISOString(),
      topKCount: review.topKDocs,
      cache: docsIndexCache,
      embeddingId,
    },
    `${changes.title}\n${changes.files.map(file => file.path).join('\n')}`,
  );
  const fileContents = readChangedFiles(changes.files, path => {
    try {
      return readFileSync(`${review.workingDir}/${path}`, 'utf8');
    } catch {
      return null;
    }
  });

  console.error('генерирую ревью…');
  const result = await generateReview(
    {
      client,
      structuredOutputs: llm.structuredOutputs,
      disableThinking: review.disableThinking,
      requestTimeoutMs: llm.requestTimeoutMs,
      temperature: review.temperature,
      maxTokens: review.maxTokens,
      contextTokens: llm.contextTokens,
    },
    {
      title: changes.title,
      description: changes.description,
      files: changes.files,
      docFragments,
      fileContents,
    },
  );

  const validated = validateFindings(result.findings, changes.files);
  // Пост-обработка: дедуп по строке, порог важности (мелочи → в сводку), лимит инлайна.
  const processed = postprocessFindings(validated, {
    minSeverity: review.minSeverity,
    maxInline: review.maxInline,
  });
  const publication = buildPublication(result.summary, processed);

  if (dryRun || platform === null) {
    console.log('\n===== DRY-RUN: ревью не публикуется =====\n');
    console.log(publication.summary);
    console.log(`\nИнлайн-комментарии (${publication.comments.length}):`);
    for (const comment of publication.comments) {
      console.log(`\n— ${comment.file}:${comment.line}\n${comment.body}`);
    }
    return;
  }

  // Публикация идемпотентна внутри (снимает свои прежние инлайн-комментарии, обновляет сводку) —
  // повторный прогон по новым коммитам не плодит ни дублей у строк, ни стопки сводок.
  await platform.publish(publication);
  console.error(`ревью опубликовано: ${publication.comments.length} инлайн-комментариев + сводка`);
}

/** Платформа не поддержана — понятная ошибка (GitLab-адаптер — следующим инкрементом). */
function throwUnsupported(platform: string): never {
  throw new Error(`Платформа ${platform} пока не поддержана (реализован GitHub).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
