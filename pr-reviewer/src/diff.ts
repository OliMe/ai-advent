/** Статус файла в PR. */
export type FileStatus = 'added' | 'modified' | 'removed' | 'renamed' | 'binary';

/** Изменённый файл: путь, статус, текст ханков и строки, на которые можно оставить инлайн-комментарий. */
export interface DiffFile {
  /** Путь к файлу в НОВОЙ версии. */
  path: string;
  /** Прежний путь (для переименований). */
  oldPath?: string;
  status: FileStatus;
  /** Текст ханков (то, что показывается в diff) — для подачи в модель. */
  patch: string;
  /**
   * Номера строк в НОВОЙ версии файла, на которые платформа принимает инлайн-комментарий (сторона
   * RIGHT): добавленные и контекстные строки внутри ханков. Удалённые строки не входят — их нет в
   * новой версии.
   */
  commentableLines: Set<number>;
}

/** Заголовок ханка: `@@ -oldStart[,oldCount] +newStart[,newCount] @@`. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Комментируемые строки одного patch (набора ханков): проходит ханки и считает номера строк новой
 * версии для добавленных (`+`) и контекстных (` `) строк. Удалённые (`-`) номер новой версии не
 * двигают. `\ No newline…` игнорируется. Некорректный ханк без заголова пропускается.
 */
export function commentableLinesOf(patch: string): Set<number> {
  const lines = new Set<number>();
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      newLine = Number(header[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line === '') {
      // Строки тела ханка всегда начинаются с маркера (пробел/+/-); пустая строка — конец ханка
      // (напр. хвост секции после разбиения). Прекращаем счёт до следующего заголовка.
      inHunk = false;
      continue;
    }
    const marker = line[0];
    if (marker === '+') {
      lines.add(newLine);
      newLine++;
    } else if (marker === '-') {
      // удалённая строка — в новой версии её нет, счётчик новой версии не двигаем
    } else if (marker === '\\') {
      // «\ No newline at end of file» — служебная строка, пропускаем
    } else {
      // контекстная строка (пробел) или пустая строка тела ханка
      lines.add(newLine);
      newLine++;
    }
  }
  return lines;
}

/** Путь из строки `+++ b/path` (или `--- a/path`), сняв префикс `a/`/`b/` и обёртку. */
function pathFromMarker(line: string): string | null {
  const raw = line.slice(4).trim();
  if (raw === '/dev/null') {
    return null;
  }
  return raw.replace(/^[ab]\//, '');
}

/** Статус файла по служебным строкам секции. */
function fileStatus(section: string, hasHunks: boolean): FileStatus {
  if (/^Binary files /m.test(section) || /^GIT binary patch/m.test(section)) {
    return 'binary';
  }
  if (/^rename from /m.test(section)) {
    return 'renamed';
  }
  if (/^new file mode /m.test(section)) {
    return 'added';
  }
  if (/^deleted file mode /m.test(section)) {
    return 'removed';
  }
  return hasHunks ? 'modified' : 'renamed';
}

/** Собирает один DiffFile из секции `diff --git …`. Возвращает null, если путь не определить. */
function parseSection(section: string): DiffFile | null {
  const lines = section.split('\n');
  const hunkStart = lines.findIndex(line => line.startsWith('@@ '));
  const hasHunks = hunkStart !== -1;
  const patch = hasHunks ? lines.slice(hunkStart).join('\n') : '';

  let newPath: string | null = null;
  let oldPath: string | null = null;
  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      newPath = pathFromMarker(line);
    } else if (line.startsWith('--- ')) {
      oldPath = pathFromMarker(line);
    } else if (line.startsWith('rename to ')) {
      newPath = line.slice('rename to '.length).trim();
    } else if (line.startsWith('rename from ')) {
      oldPath = line.slice('rename from '.length).trim();
    }
  }
  // Нет `+++`/`rename to` (напр. только-удаление или бинарник) — берём путь из строки `diff --git`.
  if (newPath === null) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0]);
    newPath = header === null ? oldPath : header[2];
  }
  if (newPath === null) {
    return null;
  }
  const status = fileStatus(section, hasHunks);
  return {
    path: newPath,
    ...(oldPath !== null && oldPath !== newPath ? { oldPath } : {}),
    status,
    patch,
    commentableLines: commentableLinesOf(patch),
  };
}

/**
 * Разбирает полный unified diff (несколько файлов) в список `DiffFile`. Секции делятся по строкам
 * `diff --git a/… b/…`. Для diff, где такого заголовка нет (напр. одиночный patch из API PR),
 * используйте `fileFromPatch`.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const sections = text.split(/^(?=diff --git )/m).filter(part => part.startsWith('diff --git '));
  const files: DiffFile[] = [];
  for (const section of sections) {
    const file = parseSection(section);
    if (file !== null) {
      files.push(file);
    }
  }
  return files;
}

/**
 * Собирает `DiffFile` из готовых полей: путь/статус известны (напр. из API PR: `filename`/`status`),
 * а `patch` — только ханки. Так адаптер платформы не парсит заголовки `diff --git`, которых в API нет.
 */
export function fileFromPatch(
  path: string,
  patch: string,
  status: FileStatus,
  oldPath?: string,
): DiffFile {
  return {
    path,
    ...(oldPath !== undefined && oldPath !== path ? { oldPath } : {}),
    status,
    patch,
    commentableLines: commentableLinesOf(patch),
  };
}
