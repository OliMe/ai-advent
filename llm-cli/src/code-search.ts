import type { ProjectContext, ToolSet } from '../../core/src/index.ts';
import type { ToolEvidence } from './evidence.ts';

/**
 * Промпт выбора шаблонов поиска по коду. Отдельная узкая подзадача (как rewrite в RAG): слабая
 * модель не догадывается сама сходить в код, но «назвать 1–3 слова для grep» выполняет надёжно.
 */
export const CODE_SEARCH_SYSTEM =
  'По вопросу о кодовой базе назови 1–3 ПОИСКОВЫХ ШАБЛОНА для grep по исходникам: имена функций, ' +
  'классов, файлов, ключевые идентификаторы — так, как они выглядят В КОДЕ. Опирайся на СПИСОК ФАЙЛОВ ' +
  'проекта ниже: бери имена ОТТУДА (например «citation-guard»), НЕ выдумывай и НЕ транслитерируй ' +
  'русские слова. Только шаблоны, каждый с новой строки, без пояснений, без markdown. Вопрос не о ' +
  'коде — ответь пустой строкой.';

/** Файлы проекта — контекст выбора шаблонов: имена берутся из реальных, а не выдумываются. */
export async function projectFileListings(
  toolSet: ToolSet,
  projects: ProjectContext[],
): Promise<Map<string, string[]>> {
  const name = toolSet.specs().find(spec => spec.name.endsWith('git_list_files'))?.name;
  const listings = new Map<string, string[]>();
  if (name === undefined) {
    return listings;
  }
  for (const project of projects) {
    const result = await toolSet.call(name, { repo: project.root });
    listings.set(
      project.root,
      result
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean),
    );
  }
  return listings;
}

/** Короткий шаблон совпадёт с чем угодно — по имени файла ищем только осмысленно длинные. */
const MIN_FILENAME_PATTERN = 4;

/**
 * Файлы, чьё ИМЯ совпало с шаблоном. Без этого вопрос «где реализован гейт цитат» ловил лишь
 * УПОМИНАНИЯ файла (импорты, документация), а сам `citation-guard.ts` не читался — и ассистенту
 * нечем было ответить (воспроизведено живым прогоном). Имя файла в шаблоне — прямое указание, что
 * читать: разрешаем его в реальный путь из списка файлов проекта.
 */
export function filesMatchingPatterns(paths: string[], patterns: string[]): string[] {
  const matched: string[] = [];
  for (const pattern of patterns) {
    const needle = pattern.toLowerCase().replace(/\.[a-z]+$/, '');
    if (needle.length < MIN_FILENAME_PATTERN) {
      continue;
    }
    for (const path of paths) {
      const parts = path.split('/');
      const name = parts[parts.length - 1].toLowerCase().replace(/\.[a-z]+$/, '');
      if (name === needle && !matched.includes(path)) {
        matched.push(path);
      }
    }
  }
  return matched;
}

/** Максимум шаблонов поиска по коду за ход (каждый — отдельный вызов git_grep). */
const MAX_CODE_PATTERNS = 3;

/** Шаблон длиннее этого — не идентификатор, а пересказ вопроса: в grep такое бесполезно. */
const MAX_PATTERN_LENGTH = 40;

/** Разбирает ответ модели в шаблоны поиска: непустые короткие строки, без markdown-мусора. */
export function parseCodePatterns(text: string): string[] {
  return text
    .split('\n')
    .map(line =>
      line
        .replace(/^[-*\d.\s`]+/, '')
        .replace(/[`,;]+$/, '')
        .trim(),
    )
    .filter(line => line !== '' && line.length <= MAX_PATTERN_LENGTH)
    .slice(0, MAX_CODE_PATTERNS);
}

/**
 * Принудительный поиск по КОДУ: по каждому шаблону в каждом проекте. Ровно та же логика, что у
 * форс-поиска по документации (День 25): полагаться на то, что модель сама вызовет git_grep, нельзя
 * — слабая модель этого не делает и отвечает по документации (или по памяти), то есть мимо вопроса.
 */
export async function forcedCodeSearch(
  toolSet: ToolSet,
  projects: ProjectContext[],
  patterns: string[],
  onSearch: (name: string, args: Record<string, unknown>, result: string) => void,
): Promise<ToolEvidence[]> {
  const name = toolSet.specs().find(spec => spec.name.endsWith('git_grep'))?.name;
  if (name === undefined) {
    return [];
  }
  const found: ToolEvidence[] = [];
  for (const project of projects) {
    for (const pattern of patterns) {
      const args = { repo: project.root, pattern };
      const result = await toolSet.call(name, args);
      onSearch(name, args, result);
      found.push({ name, args, result });
    }
  }
  return found;
}

/** Сколько готовых строк-кандидатов предлагать для цитирования. */
const MAX_CITATION_CANDIDATES = 5;

/** Слишком короткая строка не доказывает ничего, слишком длинная — не «выдержка». */
const CANDIDATE_MIN_LENGTH = 20;
const CANDIDATE_MAX_LENGTH = 200;

/**
 * Готовые строки для секции «Цитаты» — дословные строки из добытого материала, содержащие искомые
 * шаблоны. Слабая модель ПЕРЕСКАЗЫВАЕТ вместо цитирования и валит цитатный гейт (проверено живьём:
 * пять перегенераций подряд → безопасный фолбэк «не могу подтвердить», ответа нет). Готовый кандидат
 * превращает задачу «процитируй дословно» в «скопируй одну строку», что посильно и 7B-модели.
 * Кандидаты — подстроки чанков доказательств, поэтому гейт их принимает (он же их и сверяет).
 */
export function citationCandidates(evidence: ToolEvidence[], patterns: string[]): string[] {
  const candidates: string[] = [];
  for (const item of evidence) {
    for (const line of item.result.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length < CANDIDATE_MIN_LENGTH || trimmed.length > CANDIDATE_MAX_LENGTH) {
        continue;
      }
      const relevant = patterns.some(pattern =>
        trimmed.toLowerCase().includes(pattern.toLowerCase()),
      );
      if (relevant && !candidates.includes(trimmed)) {
        candidates.push(trimmed);
      }
      if (candidates.length >= MAX_CITATION_CANDIDATES) {
        return candidates;
      }
    }
  }
  return candidates;
}

/** Максимум файлов, дочитываемых по совпадениям grep (каждый — чтение целиком, дорого по контексту). */
export const MAX_FILES_TO_READ = 3;

/** Строка `git grep`: `путь:строка:текст`. Берём путь. */
const GREP_LINE = /^([^\s:][^:]*):\d+:/;

/**
 * Файлы, на которые указали совпадения grep (уникальные, в порядке частоты). По одной строке
 * совпадения код не понять — ассистент должен прочитать сам файл, а не догадываться.
 */
export function filesFromHits(hits: ToolEvidence[]): { repo: string; path: string }[] {
  const counts = new Map<string, { repo: string; path: string; count: number }>();
  for (const hit of hits) {
    const repo = typeof hit.args.repo === 'string' ? hit.args.repo : '';
    for (const line of hit.result.split('\n')) {
      const matched = GREP_LINE.exec(line);
      if (matched === null) {
        continue;
      }
      const path = matched[1];
      const key = `${repo} ${path}`;
      const existing = counts.get(key);
      if (existing === undefined) {
        counts.set(key, { repo, path, count: 1 });
      } else {
        existing.count++;
      }
    }
  }
  return [...counts.values()]
    .sort((first, second) => second.count - first.count)
    .slice(0, MAX_FILES_TO_READ)
    .map(({ repo, path }) => ({ repo, path }));
}

/** Принудительно читает файлы (сами, а не «попросив» модель) — результат идёт в доказательства. */
export async function forcedFileReads(
  toolSet: ToolSet,
  files: { repo: string; path: string }[],
  onRead: (name: string, args: Record<string, unknown>, result: string) => void,
): Promise<ToolEvidence[]> {
  const name = toolSet.specs().find(spec => spec.name.endsWith('read_file'))?.name;
  if (name === undefined) {
    return [];
  }
  const read: ToolEvidence[] = [];
  for (const file of files) {
    const args = { repo: file.repo, path: file.path };
    const result = await toolSet.call(name, args);
    onRead(name, args, result);
    read.push({ name, args, result });
  }
  return read;
}
