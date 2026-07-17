import type { ChatMessage, ToolSet } from '../../core/src/index.ts';
import type { SearchChunk } from '../../grounding/src/index.ts';
import { toEvidenceChunks } from '../../grounding/src/index.ts';
import {
  CODE_SEARCH_SYSTEM,
  projectFileListings,
  parseCodePatterns,
  forcedCodeSearch,
  filesMatchingPatterns,
  filesFromHits,
  forcedFileReads,
  citationCandidates,
  MAX_FILES_TO_READ,
} from '../../llm-cli/src/code-search.ts';

/**
 * Добыча доказательств из КОДА для ответа поддержки (тумблер `SUPPORT_CODE_SEARCH`). Детерминированно,
 * по образцу `/ask` Дня 31: модель называет 1–3 шаблона для grep (узкая подзадача, по РЕАЛЬНОМУ списку
 * файлов) → форс-`git_grep` → чтение файлов → `toEvidenceChunks` (код становится цитируемым, как
 * фрагмент документации). Механизм переиспользован из llm-cli (`code-search.ts`), обёрнут под бота.
 */

/** Зависимости добычи кода (инъекция — для тестов). */
export interface CodeEvidenceDeps {
  /** ToolSet с подключённым git-mcp (`git_list_files`/`git_grep`/`read_file`). */
  toolSet: ToolSet;
  /** Корень репозитория, по которому ищем. */
  repoRoot: string;
  /** Одиночная генерация для выбора шаблонов grep (низкая температура — детерминизм). */
  complete: (messages: ChatMessage[]) => Promise<string>;
  /** Печать вызовов инструментов (наблюдаемость). */
  onToolCall?: (name: string, args: Record<string, unknown>, result: string) => void;
}

/** Доказательства из кода: чанки для цитатного гейта + готовые дословные строки для «Цитат». */
export interface CodeEvidence {
  chunks: SearchChunk[];
  candidates: string[];
}

/** Пустой результат (нет инструментов / модель не назвала шаблонов / вопрос не о коде). */
const EMPTY: CodeEvidence = { chunks: [], candidates: [] };

/**
 * Собирает доказательства из кода по вопросу: список файлов → шаблоны (модель) → grep → чтение
 * файлов → чанки-доказательства. Нет `git_grep`/шаблонов → пустой результат (бот ответит по FAQ).
 */
export async function gatherCodeEvidence(
  deps: CodeEvidenceDeps,
  question: string,
): Promise<CodeEvidence> {
  const roots = [deps.repoRoot];
  const onCall = deps.onToolCall ?? (() => {});
  const listings = await projectFileListings(deps.toolSet, roots);
  const listingText = [...listings.entries()]
    .map(([root, paths]) => `${root}:\n${paths.join('\n')}`)
    .join('\n\n');
  const plan = await deps.complete([
    { role: 'system', content: CODE_SEARCH_SYSTEM },
    ...(listingText === ''
      ? []
      : [{ role: 'system' as const, content: `Файлы проекта:\n${listingText}` }]),
    { role: 'user', content: question },
  ]);
  const patterns = parseCodePatterns(plan);
  if (patterns.length === 0) {
    return EMPTY;
  }
  const hits = await forcedCodeSearch(deps.toolSet, roots, patterns, onCall);
  // Читаем целиком: файлы, чьё ИМЯ названо шаблоном (прямое указание), затем файлы из совпадений grep.
  const named = filesMatchingPatterns(listings.get(deps.repoRoot) ?? [], patterns).map(path => ({
    repo: deps.repoRoot,
    path,
  }));
  const toRead = [...named, ...filesFromHits(hits)]
    .filter(
      (file, index, all) =>
        all.findIndex(other => other.repo === file.repo && other.path === file.path) === index,
    )
    .slice(0, MAX_FILES_TO_READ);
  const reads = await forcedFileReads(deps.toolSet, toRead, onCall);
  const evidence = [...hits, ...reads];
  return { chunks: toEvidenceChunks(evidence), candidates: citationCandidates(evidence, patterns) };
}
