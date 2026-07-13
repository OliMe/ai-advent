import { basename } from 'node:path';
import {
  detectProjectRoot,
  loadProjectContext,
  nodeProjectIo,
  formatProjectContext,
} from '../../core/src/index.ts';
import type { ProjectContext, ProjectIo, Session, ToolSet } from '../../core/src/index.ts';

/** Суффиксы инструментов git-mcp (учитываем неймспейс сервера: `git__git_branch`). */
const BRANCH_TOOL_SUFFIX = 'git_branch';
const STATUS_TOOL_SUFFIX = 'git_status';

/** Инструмент «текущая ветка» (любого сервера, чьё имя оканчивается на `git_branch`). */
export function isGitBranchTool(name: string): boolean {
  return name.endsWith(BRANCH_TOOL_SUFFIX);
}

/** Инструмент «статус репозитория». */
export function isGitStatusTool(name: string): boolean {
  return name.endsWith(STATUS_TOOL_SUFFIX);
}

/** Переопределение документации проекта (`LLM_PROJECT_DOCS`) — для нестандартной раскладки. */
export function docSourcesOverride(raw: string | undefined): string[] | undefined {
  const sources = (raw ?? '')
    .split(',')
    .map(source => source.trim())
    .filter(Boolean);
  return sources.length === 0 ? undefined : sources;
}

/**
 * Рабочее пространство хода: привязанные проекты сессии, а если не привязано ничего — автодетект по
 * текущему каталогу (llm-cli запущен из проекта — значит, речь о нём). Путь, переставший быть
 * репозиторием, молча выпадает: держать в пространстве несуществующий проект хуже, чем не держать.
 */
export function resolveWorkspace(
  session: Session,
  workingDirectory: string,
  io: ProjectIo = nodeProjectIo,
  docSources?: string[],
): ProjectContext[] {
  const explicit = session.projects ?? [];
  const roots = explicit.length > 0 ? explicit : detectedRoots(workingDirectory, io);
  const projects: ProjectContext[] = [];
  for (const root of roots) {
    const project = loadProjectContext(root, io, docSources);
    if (project !== null) {
      projects.push(project);
    }
  }
  return projects;
}

/** Автодетект: корень репозитория над текущим каталогом (ноль или один). */
function detectedRoots(workingDirectory: string, io: ProjectIo): string[] {
  const root = detectProjectRoot(workingDirectory, io);
  return root === null ? [] : [root];
}

/** Документация всех проектов пространства — источники для RAG-поиска по вопросу о проекте. */
export function workspaceDocSources(projects: ProjectContext[]): string[] {
  return projects.flatMap(project => project.docSources);
}

/** Текущая ветка репозитория через git-mcp; инструмента нет или сбой — null (не выдумываем). */
export async function fetchGitBranch(toolSet: ToolSet, root: string): Promise<string | null> {
  const name = toolSet.specs().find(spec => isGitBranchTool(spec.name))?.name;
  if (name === undefined) {
    return null;
  }
  const result = await toolSet.call(name, { repo: root });
  const matched = /Ветка:\s*(.+)/.exec(result);
  return matched === null ? null : matched[1].trim();
}

/** Карточка проекта для пользователя: та же, что уходит агентам, плюс живая ветка из git. */
export function formatProjectCard(project: ProjectContext, branch: string | null): string {
  const card = formatProjectContext(project);
  return branch === null ? card : `${card}\n- ветка: ${branch}`;
}

/** Список привязанных проектов (в порядке привязки) с их ветками. */
export function formatProjectList(projects: ProjectContext[], branches: (string | null)[]): string {
  if (projects.length === 0) {
    return 'Проект не привязан. Привязать: /project add <путь|git URL>\n\n';
  }
  const cards = projects
    .map((project, index) => formatProjectCard(project, branches[index] ?? null))
    .join('\n\n');
  return `Проекты (${projects.length}):\n\n${cards}\n\n`;
}

/**
 * Убирает проект из списка корней по имени или пути. Возвращает null, если такого проекта нет —
 * молча «успешно удалить» несуществующее нельзя, иначе опечатка выглядит как успех.
 */
export function removeProjectRoot(roots: string[], nameOrPath: string): string[] | null {
  const wanted = nameOrPath.replace(/\/+$/, '');
  const remaining = roots.filter(root => root !== wanted && basename(root) !== wanted);
  return remaining.length === roots.length ? null : remaining;
}
