import type { Conversation } from './conversation.ts';
import type { GenerationLimits } from './types.ts';
import type { ToolSet } from './tool-set.ts';
import type { AgentContribution } from './task-run.ts';
import { parseJsonObject } from './json.ts';

/** Фабрика диалога агента (как в StageContext): системный промпт, ограничения, температура, опц. инструменты. */
type ConversationFactory = (
  systemPrompt: string,
  limits?: GenerationLimits,
  temperature?: number,
  tools?: ToolSet,
) => Conversation;

/** Роль агента в команде этапа: имя, фокус (что привносит) и опц. температура. */
export interface AgentRole {
  name: string;
  focus: string;
  temperature?: number;
}

/** Решение оркестратора: состав команды (≥1 роль) и обоснование выбора. */
export interface TeamPlan {
  roles: AgentRole[];
  rationale: string;
}

/** Системный промпт оркестратора: решает, нужна ли команда ролей, и подбирает её состав. */
export const ORCHESTRATOR_SYSTEM =
  'Ты — оркестратор команды агентов. По задаче и этапу реши, нужна ли КОМАНДА из нескольких ' +
  'экспертов разных ролей, или достаточно одного агента. По умолчанию склоняйся к ОДНОМУ агенту; ' +
  'команду собирай, только если задача действительно ОХВАТЫВАЕТ НЕСКОЛЬКО разных аспектов или ' +
  'подсистем, где разные точки зрения дадут более полный и качественный результат (например: ' +
  'проектирование новой фичи с архитектурой + безопасностью + данными + тестированием; или ' +
  'стратегия + контент + процесс + аналитика). МЕХАНИЧЕСКИЕ и ОДНОИСХОДНЫЕ задачи — ВСЕГДА одна роль: ' +
  'обновление/установка зависимостей, правка документации (README и пр.), единичная правка файла или ' +
  'конфига, форматирование/линт-фиксы, переименование, одна функция, короткий скрипт, отдельный ' +
  'маленький модуль, короткая заметка. Для них команда экспертов — пустая трата: результат один и ' +
  'узкий, разные «ракурсы» лишь дублируют друг друга. Одну роль выбирай для любой узкой задачи с ' +
  'единственным небольшим результатом. Не плоди лишних ролей: каждая должна ' +
  'покрывать ОТДЕЛЬНЫЙ значимый аспект, а не дублировать другую. Подбери ДОПОЛНЯЮЩИЕ роли ' +
  '(например: архитектор, безопасность, тестирование, UX, данные, производительность, ' +
  'доменный эксперт) — ровно те, что релевантны, и не больше лимита. Каждая роль: краткое имя ' +
  '(name) и focus — что именно она привносит. Если в контексте даны ИНВАРИАНТЫ — учитывай их ' +
  'при подборе ролей. Ответь ТОЛЬКО объектом JSON: ' +
  '{"roles":[{"name":"...","focus":"...","temperature":0.7}],"rationale":"почему такой состав"}.';

/** Универсальная одиночная роль — для однопроходного режима (её фокус не используется). */
const GENERIC_ROLE: AgentRole = { name: 'универсальный', focus: '' };

/** Команда из одного универсального агента (однопроходный режим). */
function soloTeam(rationale: string): TeamPlan {
  return { roles: [GENERIC_ROLE], rationale };
}

/** Разбирает одну роль из значения JSON (имя обязательно; иначе null). */
function parseRole(value: unknown): AgentRole | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (name === '') {
    return null;
  }
  const focus = typeof record.focus === 'string' ? record.focus.trim() : '';
  const temperature =
    typeof record.temperature === 'number' && Number.isFinite(record.temperature)
      ? record.temperature
      : undefined;
  return { name, focus, ...(temperature === undefined ? {} : { temperature }) };
}

/**
 * Разбирает решение оркестратора: список ролей (зажатый по `maxAgents`) + обоснование.
 * Пустой/неразобранный ответ — фолбэк на одиночную универсальную роль.
 */
export function parseTeamPlan(content: string, maxAgents: number): TeamPlan {
  const object = parseJsonObject(content);
  const rawRoles = Array.isArray(object?.roles) ? object.roles : [];
  const roles = rawRoles
    .map(parseRole)
    .filter((role): role is AgentRole => role !== null)
    .slice(0, Math.max(1, maxAgents));
  if (roles.length === 0) {
    return soloTeam('');
  }
  const rationale = typeof object?.rationale === 'string' ? object.rationale : '';
  return { roles, rationale };
}

/** Параметры оркестрации команды этапа. */
export interface OrchestrateOptions {
  makeConversation: ConversationFactory;
  /** Задача (заголовок прогона). */
  task: string;
  /** Контекст: память задачи + блок инвариантов (или пусто). */
  context: string;
  /** Название этапа для промпта («планирование»/«выполнение»). */
  stageLabel: string;
  /** Потолок числа ролей; ≤1 — многоагентность выключена (модель не зовём). */
  maxAgents: number;
}

/**
 * Решает состав команды этапа. При `maxAgents ≤ 1` многоагентность выключена —
 * возвращает одиночную роль без обращения к модели. Сбой оркестратора → одиночная роль.
 */
export async function orchestrateTeam(options: OrchestrateOptions): Promise<TeamPlan> {
  if (options.maxAgents <= 1) {
    return soloTeam('многоагентность выключена (лимит 1)');
  }
  const conversation = options.makeConversation(ORCHESTRATOR_SYSTEM);
  const prefix = options.context ? `${options.context}\n\n` : '';
  const prompt =
    `${prefix}Этап: ${options.stageLabel}\nЗадача: ${options.task}\n\n` +
    `Лимит ролей: ${options.maxAgents}. Подбери состав команды.`;
  try {
    const result = await conversation.ask(prompt);
    return parseTeamPlan(result.content, options.maxAgents);
  } catch {
    return soloTeam('оркестратор недоступен — один агент');
  }
}

/**
 * Прогоняет элементы через `worker` с ограничением одновременных запусков `limit`,
 * сохраняя порядок результатов. Для веера роль-агентов внутри этапа.
 */
export async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  limit: number,
  worker: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = new Array(items.length);
  const bound = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  async function runWorker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: bound }, () => runWorker()));
  return results;
}

/** Параметры запуска роль-экспертов этапа. */
export interface RoleExpertsOptions {
  roles: readonly AgentRole[];
  makeConversation: ConversationFactory;
  /** Системный промпт агента под роль. */
  buildSystem: (role: AgentRole) => string;
  /** Задание агенту под роль (общая часть задачи). */
  buildPrompt: (role: AgentRole) => string;
  /** Максимум одновременных запросов. */
  concurrency: number;
  /**
   * Инструменты (function-calling) для роль-экспертов — чтобы они РЕАЛЬНО читали файлы/структуру
   * проекта (read_file/git_grep/...), а не только просили «мне нужно посмотреть package.json».
   * Не заданы — эксперты работают без инструментов (как прежде).
   */
  tools?: ToolSet;
  /** Уведомление о сбое отдельной роли (её вклад пропускается). */
  onError?: (role: AgentRole, error: unknown) => void;
}

/**
 * Запускает роль-экспертов ограниченно-параллельно и собирает их вклады. Сбой отдельной
 * роли не валит этап — её вклад пропускается (с уведомлением `onError`), остальные идут.
 */
export async function runRoleExperts(options: RoleExpertsOptions): Promise<AgentContribution[]> {
  const collected = await mapWithConcurrency(
    options.roles,
    options.concurrency,
    async (role): Promise<AgentContribution | null> => {
      try {
        const conversation = options.makeConversation(
          options.buildSystem(role),
          undefined,
          role.temperature,
          options.tools,
        );
        const result = await conversation.ask(options.buildPrompt(role));
        return { role: role.name, text: result.content };
      } catch (error) {
        options.onError?.(role, error);
        return null;
      }
    },
  );
  return collected.filter(
    (contribution): contribution is AgentContribution => contribution !== null,
  );
}
