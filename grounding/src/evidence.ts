import { basename } from 'node:path';
import type { SearchChunk } from './rag-answer.ts';

/** Вызов инструмента за ход: имя, аргументы и текстовый результат. */
export interface ToolEvidence {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

/** Инструменты git-mcp, чей вывод — ДОКАЗАТЕЛЬСТВО о коде (его можно дословно цитировать). */
const CODE_TOOL_SUFFIXES = ['read_file', 'git_grep', 'git_list_files', 'git_diff', 'git_log'];

/** Инструмент, чей результат идёт в доказательную базу (учитываем неймспейс сервера). */
export function isCodeEvidenceTool(name: string): boolean {
  return CODE_TOOL_SUFFIXES.some(suffix => name.endsWith(suffix));
}

/** Строковый аргумент или undefined. */
function stringArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Что именно смотрели инструментом: файл, шаблон поиска или подкаталог. */
function subject(evidence: ToolEvidence): string {
  return (
    stringArg(evidence.args.path) ??
    stringArg(evidence.args.pattern) ??
    stringArg(evidence.args.subdir) ??
    'репозиторий'
  );
}

/**
 * Превращает результаты инструментов кода в чанки доказательной базы. Нужно, чтобы цитатный гейт
 * Дня 24 (источники ⊂ найденного + дословная цитата-якорь) работал и для ответов ПО КОДУ: код в
 * RAG-индекс не кладётся, поэтому без этого ответ о коде честно сослаться было бы не на что, и гейт
 * валил бы его в «не подтверждено». Теперь код — такое же доказательство, как фрагмент документации,
 * и выдумать его так же нельзя (сверка строковая).
 */
export function toEvidenceChunks(calls: ToolEvidence[]): SearchChunk[] {
  return calls
    .filter(call => isCodeEvidenceTool(call.name))
    .map(call => {
      const repository = stringArg(call.args.repo);
      const project = repository === undefined ? 'проект' : basename(repository);
      const where = subject(call);
      // Секция — каким инструментом добыто (снимаем неймспейс сервера: git__git_grep → git_grep).
      const parts = call.name.split('__');
      return {
        chunk_id: `${project} › ${where}`,
        source: repository ?? project,
        file: where,
        section: parts[parts.length - 1],
        // Код добыт точечно, а не ранжирован ретривом: «уверенность» здесь не измеряется.
        score: 1,
        text: call.result,
      };
    });
}
