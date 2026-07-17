/**
 * Точка входа ассистента поддержки (тонкая проводка, вне покрытия). Ветка `--warm-cache` — прогрев
 * индекса FAQ (нужен только эмбеддер). Иначе — полный поток: подключить CRM через MCP (support-mcp по
 * stdio), собрать FAQ по вопросу тикета, синтезировать ответ с цитатным гейтом и запостить обратно.
 * Диагностика идёт в stderr.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  loadConfig,
  loadEmbeddingsConfig,
  ChatCompletionClient,
  EmbeddingsClient,
} from '../../core/src/index.ts';
import type { ChatMessage } from '../../core/src/index.ts';
import { loadLocalDocuments, nodeLocalIo } from '../../rag/src/index.ts';
import { retrieveDocChunks, warmDocsIndex, FileIndexCache } from '../../grounding/src/index.ts';
import type { IndexCacheIo } from '../../grounding/src/index.ts';
import { loadSupportBotConfig } from './config.ts';
import { runSupportFlow } from './flow.ts';

/** Флаг присутствует в argv. */
function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

/** Температура синтеза — низкая: ответ собирается по фактам FAQ, творчество тут вредит. */
const RESPONSE_TEMPERATURE = 0.2;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const packageDir = join(import.meta.dirname, '..');
  const config = loadSupportBotConfig(process.env, packageDir);

  const embeddingsConfig = loadEmbeddingsConfig(process.env);
  const embeddings = new EmbeddingsClient(embeddingsConfig);
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
  const cache = new FileIndexCache(config.cacheDir, cacheIo);
  const docs = loadLocalDocuments(config.faqDir, nodeLocalIo);

  if (hasFlag(argv, '--warm-cache')) {
    const chunkCount = await warmDocsIndex({
      embed: inputs => embeddings.embed(inputs),
      loadDocs: () => docs,
      now: new Date().toISOString(),
      topKCount: 1,
      cache,
      embeddingId: embeddingsConfig.model,
    });
    console.error(
      `FAQ-индекс прогрет: ${docs.length} документов, ${chunkCount} чанков → ${config.cacheDir}`,
    );
    return;
  }

  if (config.repo === '' || config.issueNumber === 0) {
    throw new Error('Нужны SUPPORT_REPO (owner/name) и SUPPORT_ISSUE_NUMBER (номер тикета).');
  }

  // CRM через MCP: спавним support-mcp по stdio. Child наследует env (PATH и SUPPORT_*), т.к.
  // StdioClientTransport заменяет окружение переданным.
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  childEnv.SUPPORT_REPO = config.repo;
  childEnv.SUPPORT_TOKEN = config.token;
  childEnv.SUPPORT_API_URL = config.apiBaseUrl;

  // Ленивый импорт mcp-client: он тянет @modelcontextprotocol/sdk, который нужен ТОЛЬКО в полном
  // потоке ответа. Прогрев кэша (--warm-cache, ветка выше) обходится без него и без npm install SDK.
  const { McpToolSet, connectionFactory } = await import('../../mcp-client/src/index.ts');
  const supportMcpCli = join(packageDir, '..', 'support-mcp', 'src', 'cli.ts');
  const toolSet = new McpToolSet(connectionFactory());
  await toolSet.addServer('support', {
    transport: 'stdio',
    command: process.execPath,
    args: [supportMcpCli],
    env: childEnv,
  });

  const client = new ChatCompletionClient(loadConfig());
  const complete = async (messages: ChatMessage[]): Promise<string> => {
    const result = await client.completeWithUsage(messages, {
      signal: AbortSignal.timeout(loadConfig().requestTimeoutMs),
      disableThinking: config.disableThinking,
      temperature: RESPONSE_TEMPERATURE,
    });
    return result.content;
  };

  try {
    const outcome = await runSupportFlow({
      toolSet,
      issueId: config.issueNumber,
      retrieveFaq: query =>
        retrieveDocChunks(
          {
            embed: inputs => embeddings.embed(inputs),
            loadDocs: () => docs,
            now: new Date().toISOString(),
            topKCount: config.topKFaq,
            cache,
            embeddingId: embeddingsConfig.model,
          },
          query,
        ),
      complete,
      linkRef: config.ref,
      repoRoot: config.repoRoot,
      onCitationFailure: (reason, attempt) =>
        console.error(`цитатный гейт (попытка ${attempt}): ${reason}`),
    });
    if (outcome.posted) {
      console.error(`ответ опубликован в тикет #${config.issueNumber}`);
    } else {
      console.error(`пропущено: ${outcome.reason}`);
    }
  } finally {
    await toolSet.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
