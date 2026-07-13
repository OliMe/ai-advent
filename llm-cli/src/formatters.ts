import { estimateTokens } from '../../core/src/index.ts';
import type {
  ProfileSummary,
  RunStatus,
  RunSummary,
  SessionSummary,
  Stage,
  StageArtifacts,
  Task,
  TaskRun,
  TaskSummary,
  TeamPlan,
  ToolSpec,
} from '../../core/src/index.ts';

/** Бюджет (в токенах) на блок деталей задачи в контексте агентов пайплайна. */
export const RUN_CONTEXT_DETAIL_BUDGET_TOKENS = 1500;

/** Сообщение, когда сессионные команды вызваны при отключённом хранилище. */
export const EPHEMERAL_NOTICE = 'Хранилище сессий отключено (--ephemeral).\n\n';

/** Сообщение, когда команды прогонов вызваны при отключённом хранилище. */
export const RUNS_EPHEMERAL_NOTICE = 'Хранилище прогонов отключено (--ephemeral).\n\n';

/** Сообщение, когда команды памяти вызваны при выключенной слоистой памяти. */
export const MEMORY_OFF_NOTICE = 'Слоистая память выключена (--no-memory).\n\n';

/** Форматирует список задач для команды /tasks. */
export function formatTaskList(summaries: TaskSummary[]): string {
  if (summaries.length === 0) {
    return 'Задач пока нет.\n\n';
  }
  const lines = summaries.map(summary => {
    const mark = summary.status === 'done' ? '✓' : '•';
    return `  ${mark} ${summary.title}  (${summary.id})  фактов: ${summary.detailCount}`;
  });
  return `Задачи:\n${lines.join('\n')}\n\n`;
}

/** Форматирует текущую задачу (с деталями) для команды /task. */
export function formatCurrentTask(task: Task | null): string {
  if (task === null) {
    return 'Активной задачи нет. Задать: /task <описание>\n\n';
  }
  const details =
    task.details.length > 0
      ? task.details.map(detail => `  - ${detail}`).join('\n')
      : '  (пока без деталей)';
  return `Текущая задача: ${task.title}\n${details}\n\n`;
}

/** Форматирует профиль пользователя (нумерованно) для команды /profile. */
export function formatProfile(entries: string[], activeName: string): string {
  const header = `Профиль «${activeName}»`;
  if (entries.length === 0) {
    return `${header}: пуст — пока ничего не знаю о ваших предпочтениях.\n\n`;
  }
  const lines = entries.map((entry, index) => `  ${index + 1}. ${entry}`);
  return `${header}:\n${lines.join('\n')}\n\n`;
}

/** Форматирует список инвариантов (нумерованный) для команды /invariants. */
export function formatInvariants(invariants: string[]): string {
  if (invariants.length === 0) {
    return 'Инвариантов нет. Задать: /invariant add <ограничение>\n\n';
  }
  const lines = invariants.map((item, index) => `  ${index + 1}. ${item}`);
  return `Инварианты (нарушать нельзя):\n${lines.join('\n')}\n\n`;
}

/**
 * Трасса вызовов инструментов за ход (порядок выбора и маршрутизации по серверам). Пусто, если
 * инструменты не вызывались. Помогает увидеть длинный кросс-серверный флоу и проверить порядок.
 */
export function formatToolTrace(calledTools: string[]): string {
  return calledTools.length === 0 ? '' : `🧭 ${calledTools.join(' → ')}\n\n`;
}

/** Форматирует подключённые MCP-серверы и их инструменты для команды /mcp. */
export function formatMcpTools(serverNames: string[], specs: ToolSpec[]): string {
  if (serverNames.length === 0) {
    return 'MCP-серверы не подключены. Добавить: /mcp add <имя> <команда | URL>\n\n';
  }
  const lines = serverNames.map(server => {
    const tools = specs
      .filter(spec => spec.name.startsWith(`${server}__`))
      .map(spec => spec.name.slice(server.length + 2));
    return `  • ${server}: ${tools.length > 0 ? tools.join(', ') : '(нет инструментов)'}`;
  });
  return `MCP-серверы:\n${lines.join('\n')}\n\n`;
}

/** Форматирует список профилей (с пометкой активного) для команды /profiles. */
export function formatProfileList(summaries: ProfileSummary[], activeName: string): string {
  // Активный профиль показываем всегда, даже если он ещё пуст и не сохранён.
  const names = summaries.map(summary => summary.name);
  const rows = names.includes(activeName)
    ? summaries
    : [{ name: activeName, entryCount: 0, updatedAt: '' }, ...summaries];
  const lines = rows.map(summary => {
    const mark = summary.name === activeName ? '*' : ' ';
    return ` ${mark} ${summary.name}  (пунктов: ${summary.entryCount})`;
  });
  return `Профили:\n${lines.join('\n')}\n\n`;
}

/** Текст справки по интерактивным командам. */
export function helpText(): string {
  return (
    'Команды:\n' +
    '  /help               — этот список\n' +
    '  /sessions           — ветки (сохранённые сессии)\n' +
    '  /branch <имя>       — ответвиться в новую ветку с именем\n' +
    '  /switch <имя|id>    — переключиться на ветку\n' +
    '  /reset              — начать новую пустую ветку\n' +
    '  /task [текст]       — показать текущую задачу; с текстом — установить текущую задачу (исполнить — /run)\n' +
    '  /tasks              — список задач\n' +
    '  /task switch <id|имя> — переключиться на задачу\n' +
    '  /task done          — закрыть текущую задачу\n' +
    '  /task delete <id|имя,…> — удалить задачу(и)\n' +
    '  /profile            — что известно о вас (активный профиль)\n' +
    '  /profiles           — список профилей (персон)\n' +
    '  /profile switch <имя> — переключить/создать профиль\n' +
    '  /profile rename <имя> — переименовать активный профиль\n' +
    '  /profile delete <имя,…> — удалить профиль(и)\n' +
    '  /profile forget <n,…> — забыть пункт(ы) профиля\n' +
    '  /run [id|описание]  — исполнить задачу по этапам (текущую/по id/новую) с памятью задачи\n' +
    '  /runs               — список прогонов задач\n' +
    '  /run status [id]    — статус текущего/указанного прогона\n' +
    '  /run continue [id]  — продолжить приостановленный прогон\n' +
    '  /run edit <правка>  — внести правку перед продолжением\n' +
    '  /run abort          — завершить задачу досрочно\n' +
    '  /invariants         — список инвариантов (жёстких ограничений)\n' +
    '  /invariant add <текст> — добавить инвариант (нарушать нельзя)\n' +
    '  /invariant delete <n,…> — удалить инвариант(ы)\n' +
    '  /system <текст>     — изменить системный промпт\n' +
    '  /file <путь>        — добавить содержимое файла в контекст\n' +
    '  /voice              — запись с микрофона → текст в строку ввода\n' +
    '  /mcp                — список подключённых MCP-серверов и их инструментов\n' +
    '  /mcp add <имя> <команда [аргументы] | URL> — подключить MCP-сервер и сохранить\n' +
    '  /mcp remove <имя>   — отключить MCP-сервер и убрать из конфигурации\n' +
    '  /mcp reload         — переподключить все серверы из mcp.json\n' +
    '  /ask <вопрос>       — спросить о проекте: ассистент ищет в документации и читает код (с источниками)\n' +
    '  /project            — привязанные проекты (корень, ветка, документация, команды)\n' +
    '  /project add <путь|git URL> — привязать проект (URL клонируется в кэш); можно несколько\n' +
    '  /project remove <имя|путь> — отвязать проект; /project off — отвязать все\n' +
    '  /rag <источник…>    — grounded-режим: искать по этим источникам на каждом вопросе (мини-чат по документам)\n' +
    '  /rag                — показать привязанные источники; /rag off — выключить\n' +
    '  /temp <число>       — изменить температуру\n' +
    '  /exit, /quit        — выход\n\n'
  );
}

/** Человекочитаемые названия этапов пайплайна. */
const STAGE_LABELS: Record<Stage, string> = {
  requirements: 'сбор требований',
  planning: 'планирование',
  execution: 'выполнение',
  verification: 'проверка',
  completion: 'завершение',
};

/** Название этапа по-русски. */
export function stageLabel(stage: Stage): string {
  return STAGE_LABELS[stage];
}

/** Человекочитаемые названия статусов прогона. */
const STATUS_LABELS: Record<RunStatus, string> = {
  running: 'идёт',
  paused: 'на паузе',
  completed: 'завершено',
  cancelled: 'отменено',
};

/** Название статуса прогона по-русски. */
export function statusLabel(status: RunStatus): string {
  return STATUS_LABELS[status];
}

/** Маркированный список строк (или пусто, если список пуст). */
function bulletList(header: string, items: string[]): string {
  return items.length > 0 ? `${header}\n${items.map(item => `  - ${item}`).join('\n')}` : '';
}

/**
 * Решение оркестратора о составе команды на этап (для печати при многоагентном прогоне).
 * Роль показывается с её фокусом; добавляется обоснование, если оно есть.
 */
export function formatTeam(stage: Stage, team: TeamPlan): string {
  const roles = team.roles
    .map(role => (role.focus ? `${role.name} (${role.focus})` : role.name))
    .join(', ');
  const why = team.rationale ? ` — ${team.rationale}` : '';
  return `🧩 Команда на этап «${stageLabel(stage)}»: ${roles}${why}`;
}

/**
 * Полный читаемый результат этапа: то, что произвёл агент (план/результат/вердикт/
 * итог) целиком, без JSON. Печатается под лейблом этапа и пишется в транскрипт сессии.
 */
export function formatStageResult(stage: Stage, artifacts: StageArtifacts): string {
  switch (stage) {
    case 'requirements': {
      const requirements = artifacts.requirements!;
      return requirements.collected.length > 0
        ? bulletList('Собранные требования:', requirements.collected)
        : 'Уточнения не потребовались.';
    }
    case 'planning': {
      const planning = artifacts.planning!;
      // Шаги списком; если их нет — показываем план прозой из text (не теряем план).
      const stepsBlock =
        planning.steps.length > 0
          ? `Шаги:\n${planning.steps.map((step, index) => `  ${index + 1}. ${step}`).join('\n')}`
          : planning.text.length > 0
            ? `План:\n${planning.text}`
            : '';
      const criteria = bulletList('Критерии приёмки:', planning.criteria);
      // Если план собрала команда — показываем вклад КАЖДОЙ роли (видно, что агенты отработали).
      const contributions = planning.contributions ?? [];
      const team =
        contributions.length > 0
          ? `Вклады ролей команды:\n${contributions
              .map(contribution => `• ${contribution.role}:\n${contribution.text}`)
              .join('\n\n')}`
          : '';
      const blocks = [stepsBlock, criteria, team].filter(block => block.length > 0);
      return blocks.length > 0 ? blocks.join('\n') : planning.text;
    }
    case 'execution': {
      const execution = artifacts.execution!;
      const head = execution.summary ? `${execution.summary}\n\n` : '';
      const files = execution.files.length > 0 ? `\n\nФайлы: ${execution.files.join(', ')}` : '';
      return `${head}${execution.text}${files}`;
    }
    case 'verification': {
      const verification = artifacts.verification!;
      const verdict = verification.passed ? 'Проверка пройдена ✓' : 'Проверка НЕ пройдена ✗';
      const issues = bulletList('Замечания:', verification.issues);
      return [verdict, issues, verification.text].filter(block => block.length > 0).join('\n');
    }
    case 'completion':
      return artifacts.completion!.text;
  }
}

/** Подробный статус прогона для команды /run status. */
export function formatRunStatus(run: TaskRun): string {
  const lines = [
    `Задача: ${run.title}  (${run.id})`,
    `Этап: ${stageLabel(run.stage)} · статус: ${statusLabel(run.status)} · ` +
      `возвраты: ${run.retries}/${run.maxRetries}`,
  ];
  if (run.correction !== undefined) {
    lines.push(`Правка к учёту: ${run.correction}`);
  }
  const { requirements, planning, execution, verification, completion } = run.artifacts;
  if (requirements !== undefined) {
    lines.push(`  Требования: ${requirements.collected.length} пункт(ов)`);
  }
  if (planning !== undefined) {
    lines.push(
      `  Планирование: ${planning.steps.length} шаг(ов), ${planning.criteria.length} критери(ев)`,
    );
  }
  if (execution !== undefined) {
    const files = execution.files.length > 0 ? ` (${execution.files.join(', ')})` : '';
    lines.push(`  Выполнение: ${execution.summary}${files}`);
  }
  if (verification !== undefined) {
    lines.push(`  Проверка: ${verification.passed ? 'пройдена' : 'есть замечания'}`);
  }
  if (completion !== undefined) {
    lines.push(`  Завершение: ${completion.summary}`);
  }
  return `${lines.join('\n')}\n\n`;
}

/** Оставляет самые свежие детали (с конца), укладывающиеся в бюджет; всегда ≥1. */
function recentDetailsWithinBudget(details: string[], budgetTokens: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let index = details.length - 1; index >= 0; index--) {
    const next = used + estimateTokens(details[index]);
    if (next > budgetTokens && kept.length > 0) {
      break; // бюджет исчерпан — старые детали опускаем
    }
    kept.unshift(details[index]);
    used = next;
  }
  return kept;
}

/**
 * Контекст памяти для агентов пайплайна: детали задачи + активный профиль. Детали
 * ограничиваются бюджетом (свежие важнее), чтобы у долгой задачи контекст не рос
 * неограниченно; опущенные ранние детали помечаются.
 */
export function formatRunContext(
  details: string[],
  profile: string[],
  detailBudgetTokens: number = RUN_CONTEXT_DETAIL_BUDGET_TOKENS,
): string {
  const parts: string[] = [];
  if (details.length > 0) {
    const kept = recentDetailsWithinBudget(details, detailBudgetTokens);
    const omitted = kept.length < details.length ? '- … (ранние детали опущены)\n' : '';
    parts.push(`Контекст задачи:\n${omitted}${kept.map(detail => `- ${detail}`).join('\n')}`);
  }
  if (profile.length > 0) {
    parts.push(`О пользователе:\n${profile.map(entry => `- ${entry}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

/** Список прогонов задач для команды /runs. */
export function formatRunList(summaries: RunSummary[]): string {
  if (summaries.length === 0) {
    return 'Прогонов задач пока нет.\n\n';
  }
  const lines = summaries.map(
    summary =>
      `  ${summary.title}  (${summary.id})  ${stageLabel(summary.stage)} · ${statusLabel(summary.status)}`,
  );
  return `Прогоны задач:\n${lines.join('\n')}\n\n`;
}

/** Форматирует список веток (сессий) для команды /sessions. */
export function formatSessionList(summaries: SessionSummary[]): string {
  if (summaries.length === 0) {
    return 'Сохранённых веток нет.\n\n';
  }
  const lines = summaries.map(
    summary => `  ${summary.label ?? '—'}  (${summary.id})  ${summary.preview || '(пусто)'}`,
  );
  return `Ветки:\n${lines.join('\n')}\n\n`;
}
