/**
 * CLI RAG-индексатора: build (собрать индекс), compare (сравнить 2 стратегии), query (ретрив).
 * Только проводка (источники + EmbeddingsClient + индекс) — исключён из покрытия. Эмбеддинги по
 * умолчанию через локальный Ollama; переопределяются LLM_EMBEDDINGS_URL/MODEL/API_KEY в .env.
 */
import { stdout } from 'node:process';
import { basename } from 'node:path';
import { EmbeddingsClient, loadEmbeddingsConfig } from '../../core/src/index.ts';
import {
  buildIndex,
  computeStats,
  topK,
  loadDocuments,
  JsonIndexStore,
  nodeLoaders,
} from './index.ts';
import type { ChunkStrategy, ChunkOptions } from './index.ts';

/** Разбирает аргументы: позиционные + флаги (--key value / --key=value). */
function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
        flags.set(arg.slice(2), argv[++i]);
      } else {
        flags.set(arg.slice(2), 'true');
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** Целое из флага или значение по умолчанию. */
function intFlag(flags: Map<string, string>, name: string, fallback: number): number {
  const value = Number(flags.get(name));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Собирает клиент эмбеддингов (Ollama по умолчанию, переопределяется окружением). */
function makeEmbeddings(): { client: EmbeddingsClient; model: string } {
  process.env.LLM_EMBEDDINGS_URL ||= 'http://localhost:11434/v1/embeddings';
  process.env.LLM_EMBEDDINGS_MODEL ||= 'nomic-embed-text';
  const config = loadEmbeddingsConfig(process.env);
  return { client: new EmbeddingsClient(config), model: config.model };
}

/** Опции чанкинга из флагов. */
function chunkOptions(flags: Map<string, string>): ChunkOptions {
  return {
    fixed: { size: intFlag(flags, 'size', 2000), overlap: intFlag(flags, 'overlap', 256) },
    structuralMaxSize: intFlag(flags, 'max-size', 2000),
  };
}

/** Путь к файлу индекса по умолчанию: <имя источника>.<стратегия>.index.json. */
function defaultIndexPath(source: string, strategy: ChunkStrategy): string {
  const name = basename(source.replace(/\/+$/, '')) || 'index';
  return `${name}.${strategy}.index.json`;
}

/** build: загрузить документы, собрать индекс выбранной стратегией, сохранить. */
async function runBuild(positional: string[], flags: Map<string, string>): Promise<void> {
  const source = positional[0];
  if (!source) {
    throw new Error('Укажите источник: rag build <путь|github-url|web-url> [--strategy …]');
  }
  const strategy: ChunkStrategy = flags.get('strategy') === 'structural' ? 'structural' : 'fixed';
  const { client, model } = makeEmbeddings();
  const loaders = nodeLoaders({ depth: intFlag(flags, 'depth', 2), maxBytes: 1_000_000 });
  stdout.write(`📥 Загружаю источник: ${source}\n`);
  const documents = await loadDocuments(source, loaders);
  stdout.write(`   документов: ${documents.length}; стратегия: ${strategy}; эмбеддинг…\n`);
  const index = await buildIndex(documents, {
    strategy,
    chunk: chunkOptions(flags),
    embed: inputs => client.embed(inputs),
    model,
    createdAt: new Date().toISOString(),
  });
  const out = flags.get('out') ?? defaultIndexPath(source, strategy);
  new JsonIndexStore(out).save(index);
  stdout.write(`✅ Индекс: ${index.chunks.length} чанков (${index.dimensions}d) → ${out}\n`);
}

/** compare: собрать обе стратегии и напечатать таблицу статистики. */
async function runCompare(positional: string[], flags: Map<string, string>): Promise<void> {
  const source = positional[0];
  if (!source) {
    throw new Error('Укажите источник: rag compare <путь|github-url|web-url>');
  }
  const { client, model } = makeEmbeddings();
  const loaders = nodeLoaders({ depth: intFlag(flags, 'depth', 2), maxBytes: 1_000_000 });
  stdout.write(`📥 Загружаю источник: ${source}\n`);
  const documents = await loadDocuments(source, loaders);
  stdout.write(`   документов: ${documents.length}; собираю обе стратегии…\n\n`);
  const options = chunkOptions(flags);
  stdout.write('стратегия    | чанков | ср.размер | мин | макс | с section\n');
  stdout.write('-------------|--------|-----------|-----|------|----------\n');
  for (const strategy of ['fixed', 'structural'] as ChunkStrategy[]) {
    const index = await buildIndex(documents, {
      strategy,
      chunk: options,
      embed: inputs => client.embed(inputs),
      model,
      createdAt: new Date().toISOString(),
    });
    new JsonIndexStore(defaultIndexPath(source, strategy)).save(index);
    const s = computeStats(index);
    stdout.write(
      `${strategy.padEnd(12)} | ${String(s.chunkCount).padStart(6)} | ` +
        `${String(s.avgSize).padStart(9)} | ${String(s.minSize).padStart(3)} | ` +
        `${String(s.maxSize).padStart(4)} | ${s.withSection}/${s.chunkCount}\n`,
    );
  }
}

/** query: загрузить индекс, заэмбеддить запрос, напечатать top-k чанков. */
async function runQuery(positional: string[], flags: Map<string, string>): Promise<void> {
  const [indexPath, ...queryWords] = positional;
  const query = queryWords.join(' ');
  if (!indexPath || query === '') {
    throw new Error('Использование: rag query <файл-индекса> <запрос…> [--k N]');
  }
  const index = new JsonIndexStore(indexPath).load();
  const { client } = makeEmbeddings();
  const [queryVector] = await client.embed([query]);
  const results = topK(queryVector, index.chunks, intFlag(flags, 'k', 5));
  stdout.write(`🔎 «${query}» в ${indexPath} (${index.strategy}):\n\n`);
  for (const { chunk, score } of results) {
    const snippet = chunk.text.replace(/\s+/g, ' ').slice(0, 160);
    stdout.write(`[${score.toFixed(3)}] ${chunk.file} › ${chunk.section}\n   ${snippet}…\n\n`);
  }
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // .env необязателен (Ollama без ключа).
  }
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  if (command === 'build') {
    await runBuild(positional, flags);
  } else if (command === 'compare') {
    await runCompare(positional, flags);
  } else if (command === 'query') {
    await runQuery(positional, flags);
  } else {
    stdout.write(
      'rag — RAG-индексатор\n\n' +
        '  rag build <источник> [--strategy fixed|structural] [--out f] [--depth N] [--size N] [--overlap N] [--max-size N]\n' +
        '  rag compare <источник> [--depth N] [--size N] [--overlap N] [--max-size N]\n' +
        '  rag query <файл-индекса> <запрос…> [--k N]\n\n' +
        'Источник: путь к папке / github-URL / URL документации (автоопределение).\n' +
        'Эмбеддинги: Ollama по умолчанию; переопределить — LLM_EMBEDDINGS_URL/MODEL/API_KEY.\n',
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
