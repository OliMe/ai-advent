/**
 * Реальный ввод-вывод источников поверх node:fs / fetch / tar. Тонкая обвязка (обход ФС, сеть,
 * распаковка архива) — исключена из покрытия; вся логика фильтрации/обхода/разбора — в чистых
 * модулях local/web/github/resolve, которые сюда инжектируются.
 */
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { Document } from '../types.ts';
import type { LocalIo } from './local.ts';
import { loadLocalDocuments } from './local.ts';
import { crawlWeb } from './web.ts';
import { githubTarballUrl } from './github.ts';
import type { SourceLoaders } from './resolve.ts';

/** Каталоги, которые при обходе пропускаем целиком. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache']);

/**
 * Реальный ввод-вывод локального источника: рекурсивный обход папки (с пропуском мусорных каталогов)
 * либо ОДИН файл, если источником указан файл. Файл-источник нужен, чтобы индексировать документацию
 * точечно (`README.md`, `openapi.yaml`), не утаскивая в индекс весь код репозитория.
 */
export const nodeLocalIo: LocalIo = {
  listFiles(root: string): string[] {
    if (statSync(root).isFile()) {
      return [root];
    }
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) {
            walk(full);
          }
        } else if (entry.isFile()) {
          files.push(full);
        }
      }
    };
    walk(root);
    return files;
  },
  readText: (path: string) => readFileSync(path, 'utf8'),
};

/** Загружает HTML по URL; null — не 2xx, не HTML или сбой. */
async function nodeFetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      return null;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('html')) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  }
}

/** Скачивает GitHub-репозиторий tar.gz во временную папку, распаковывает и грузит документы. */
async function loadGithubDocuments(input: string, maxBytes: number): Promise<Document[]> {
  const response = await fetch(githubTarballUrl(input), { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`Не удалось скачать архив GitHub (${response.status}) для ${input}`);
  }
  const workDir = mkdtempSync(join(tmpdir(), 'rag-gh-'));
  try {
    const archive = join(workDir, 'repo.tar.gz');
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    execFileSync('tar', ['-xzf', archive, '-C', workDir, '--strip-components=1']);
    rmSync(archive, { force: true });
    return loadLocalDocuments(workDir, nodeLocalIo, maxBytes).map(doc => ({
      ...doc,
      source: input,
    }));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** Собирает реальные загрузчики источников (local/github/web) с заданными параметрами. */
export function nodeLoaders(options: { depth: number; maxBytes: number }): SourceLoaders {
  return {
    local: async input => loadLocalDocuments(input, nodeLocalIo, options.maxBytes),
    github: input => loadGithubDocuments(input, options.maxBytes),
    web: input => crawlWeb(input, options.depth, nodeFetchText),
  };
}
