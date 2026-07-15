/**
 * Точка входа AI-ревью PR (тонкая проводка, вне покрытия). Собирает зависимости из окружения и
 * гоняет поток: получить изменения → обосновать (доки + код) → сгенерировать ревью → сверить с
 * реальными строками → опубликовать (или напечатать при --dry-run).
 *
 * Диагностика идёт в stderr; в stdout — итог ревью (удобно смотреть в логах Action).
 */
import { readFileSync } from 'node:fs';
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
import { groundDocs, readChangedFiles } from './grounding.ts';
import { generateReview } from './review.ts';
import { validateFindings } from './validate.ts';
import { ownCommentIds } from './idempotency.ts';
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
  const llm = loadConfig();
  const review = loadReviewConfig(process.env, process.cwd());
  const client = new ChatCompletionClient(llm);

  // Эмбеддинги: нет конфига → embed бросает, groundDocs мягко деградирует на сырые доки.
  let embed: EmbedFn = async () => {
    throw new Error('эмбеддинги не настроены');
  };
  try {
    const embeddings = new EmbeddingsClient(loadEmbeddingsConfig(process.env));
    embed = inputs => embeddings.embed(inputs);
  } catch {
    console.error('эмбеддинги не настроены → RAG по докам деградирует на сырые доки');
  }

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
    { embed, loadDocs: () => docs, now: new Date().toISOString(), topKCount: review.topKDocs },
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

  // Идемпотентность: снимаем СВОИ прежние комментарии (по маркеру) и постим свежее ревью. Так
  // повторный прогон по новым коммитам не плодит дубли — набор комментариев бота всегда актуален.
  const removed = ownCommentIds(await platform.fetchExistingComments());
  await platform.deleteComments(removed);
  await platform.publish(publication);
  console.error(
    `ревью опубликовано: ${publication.comments.length} инлайн + сводка (снято прежних: ${removed.length})`,
  );
}

/** Платформа не поддержана — понятная ошибка (GitLab-адаптер — следующим инкрементом). */
function throwUnsupported(platform: string): never {
  throw new Error(`Платформа ${platform} пока не поддержана (реализован GitHub).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
