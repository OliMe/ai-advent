import type { ChatCompletionClient, CompletionResult } from './chat-completion-client.ts';
import type { ChatMessage, Usage } from './types.ts';
import type { Profile, ProfileStore, ProfileSummary } from './profile-store.ts';
import type { Task, TaskStore, TaskSummary } from './task-store.ts';
import type { MemoryStrategy } from './memory-strategy.ts';
import { MIN_HISTORY_BUDGET_TOKENS } from './tokens.ts';
import { TaskMemory } from './memory-task.ts';
import { ProfileMemory } from './memory-profile.ts';

/** Ограничивает число диапазоном [min, max]. */
function clampTokens(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Бюджеты слоёв памяти: профиль, задача и остаток под короткую память. */
export interface LayerBudgets {
  profile: number;
  task: number;
  short: number;
}

/**
 * Делит бюджет истории между слоями. Профиль и задача — доли от контекста модели
 * (с потолками), чтобы крупнее окно — крупнее память; флаги-переопределения важнее.
 * Слои не могут занять больше половины бюджета — остаток гарантирован короткой памяти.
 */
export function layerBudgets(
  historyBudget: number,
  contextTokens: number,
  profileOverride?: number,
  taskOverride?: number,
): LayerBudgets {
  let profile = profileOverride ?? clampTokens(Math.round(contextTokens / 32), 256, 1536);
  let task = taskOverride ?? clampTokens(Math.round(contextTokens / 16), 512, 3072);
  const layersCap = Math.floor(historyBudget / 2);
  if (profile + task > layersCap) {
    const scale = layersCap / (profile + task);
    profile = Math.floor(profile * scale);
    task = Math.floor(task * scale);
  }
  const short = Math.max(MIN_HISTORY_BUDGET_TOKENS, historyBudget - profile - task);
  return { profile, task, short };
}

/** Директива персонализации: велит модели применять профиль и держаться задачи. */
const PERSONALIZATION_DIRECTIVE =
  'Учитывай профиль пользователя и текущую задачу ниже. Отвечай конкретно под его ' +
  'контекст, стек и предпочтения, держись задачи. Избегай общих вступлений и оговорок, ' +
  'если пользователь их не просит. Профиль — это дефолты; свежая реплика пользователя важнее.';

/** Параметры менеджера слоистой памяти. */
export interface MemoryManagerOptions {
  /** Включена ли слоистая память (--no-memory выключает). */
  enabled: boolean;
  /** Короткая память (окно/сжатие/факты) — работает внутри менеджера. */
  strategy: MemoryStrategy;
  budgets: LayerBudgets;
  client: ChatCompletionClient;
  requestTimeoutMs: number;
  /** Долговременный профиль (загружен заранее). */
  profile: Profile;
  /** Хранилища; null — режим «в памяти, без записи на диск» (--ephemeral). */
  profileStore: ProfileStore | null;
  taskStore: TaskStore | null;
}

/** Отчёт о записи в память — что и в какой слой записано на этом шаге. */
export interface MemoryWriteReport {
  usage: Usage | undefined;
  /** Имя задачи, если её факты обновлены (иначе null). */
  taskTitle: string | null;
  /** Сколько фактов в задаче после обновления. */
  taskFactCount: number;
  /** Какие пункты добавлены в профиль на этом шаге. */
  profileAdded: string[];
  /** Число пунктов после консолидации профиля (иначе null — это не консолидация). */
  consolidated: number | null;
}

/**
 * Менеджер слоистой памяти: оркестрирует короткую стратегию и два слоя —
 * задачный ({@link TaskMemory}) и долговременный профиль ({@link ProfileMemory}).
 * Подмешивает их блоки + директиву в запрос, извлекает память по ходу диалога и
 * консолидирует профиль в конце сессии. Хранилища = null — всё в памяти (--ephemeral).
 */
export class MemoryManager {
  readonly enabled: boolean;
  private readonly strategy: MemoryStrategy;
  private readonly budgets: LayerBudgets;
  private readonly client: ChatCompletionClient;
  private readonly requestTimeoutMs: number;
  private readonly tasks: TaskMemory;
  private readonly profiles: ProfileMemory;
  private extractedThrough = 0;
  // Предложенное (но ещё не подтверждённое) имя новой задачи.
  private proposal: string | null = null;
  // Имена предложений, от которых пользователь уже отказался (не предлагаем снова).
  private readonly declined = new Set<string>();

  constructor(options: MemoryManagerOptions) {
    this.enabled = options.enabled;
    this.strategy = options.strategy;
    this.budgets = options.budgets;
    this.client = options.client;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.tasks = new TaskMemory(options.taskStore);
    this.profiles = new ProfileMemory(options.profile, options.profileStore);
  }

  // --- Профиль (делегирование в ProfileMemory) ---
  currentProfileName(): string {
    return this.profiles.currentName();
  }
  profileEntries(): string[] {
    return this.profiles.entries();
  }
  listProfiles(): ProfileSummary[] {
    return this.profiles.list();
  }
  switchProfile(name: string): boolean {
    return this.profiles.switch(name);
  }
  deleteProfile(name: string): boolean {
    return this.profiles.delete(name);
  }
  renameProfile(newName: string): 'ok' | 'same' | 'taken' {
    return this.profiles.rename(newName);
  }
  forgetProfile(oneBasedIndices: number[]): string[] {
    return this.profiles.forget(oneBasedIndices);
  }

  // --- Задача (делегирование в TaskMemory) ---
  currentTask(): Task | null {
    return this.tasks.current();
  }
  setTask(title: string): Task {
    this.proposal = null; // задача выбрана — снимаем висящее предложение
    return this.tasks.set(title);
  }
  listTasks(): TaskSummary[] {
    return this.tasks.list();
  }
  switchTask(idOrName: string): Task | null {
    return this.tasks.switch(idOrName);
  }
  adopt(taskId: string | undefined): void {
    this.tasks.adopt(taskId);
  }
  closeTask(): string | null {
    return this.tasks.close();
  }
  deleteTask(idOrName: string): Task | null {
    return this.tasks.delete(idOrName);
  }
  getTask(idOrName: string): Task | null {
    return this.tasks.get(idOrName);
  }
  addTaskDetail(idOrName: string, detail: string): Task | null {
    return this.tasks.addDetail(idOrName, detail);
  }
  markTaskDone(idOrName: string): Task | null {
    return this.tasks.markDone(idOrName);
  }

  /** Сбрасывает состояние короткой памяти при смене ветки/сессии. */
  reset(): void {
    this.strategy.reset();
    this.extractedThrough = 0;
    this.proposal = null;
  }

  /** Забирает предложение новой задачи (если есть), очищая его. */
  takeProposal(): string | null {
    const proposed = this.proposal;
    this.proposal = null;
    return proposed;
  }

  /** Помечает предложение отклонённым — больше не предлагаем эту задачу. */
  declineProposal(title: string): void {
    this.declined.add(title);
  }

  /** Извлекает из новых реплик факты задачи и явные предпочтения (один вызов). */
  private async extract(newMessages: ChatMessage[]): Promise<CompletionResult> {
    const dialogue = newMessages
      .map(m => `${m.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${m.content}`)
      .join('\n');
    const task = this.tasks.current();
    const taskContext =
      task !== null
        ? `Текущая задача: ${task.title}\nИзвестные факты задачи:\n${task.details.join('\n')}\n\n`
        : 'Активной задачи нет.\n\n';
    const profileTexts = this.profiles.entries();
    const profileContext =
      profileTexts.length > 0 ? `Уже известно о пользователе:\n${profileTexts.join('\n')}\n\n` : '';
    const instruction =
      taskContext +
      profileContext +
      'Проанализируй новые сообщения и верни СТРОГО JSON с полями. ' +
      '"task" — обновлённый список фактов текущей задачи (цель, ограничения, решения, ' +
      'прогресс); если активной задачи нет — пустой массив. ' +
      '"user" — НОВЫЕ УСТОЙЧИВЫЕ предпочтения САМОГО пользователя, общие для разных ' +
      'задач: форма/стиль ответов, язык общения, привычные инструменты и подходы. ' +
      'Это про пользователя вообще, а НЕ про текущий проект. НЕ включай параметры ' +
      'задачи (бюджет, сроки, название проекта, выбранные под эту задачу технологии и ' +
      'архитектуру) — они идут в "task". Бери только из слов пользователя или явных ' +
      'подтверждений; не из предложений ассистента; если таких нет — пустой массив. ' +
      '"isNewTask" — true, если пользователь ставит НОВУЮ задачу/цель, отличную от ' +
      'текущей (а не уточняет её и не ведёт болтовню); иначе false. ' +
      '"proposedTitle" — краткое имя этой новой задачи (если isNewTask), иначе "". ' +
      'Без пояснений.\n\nСообщения:\n' +
      dialogue;
    return this.client.completeWithUsage([{ role: 'user', content: instruction }], {
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      disableThinking: true,
      maxTokens: this.budgets.task,
      responseFormat: { type: 'json_object' },
    });
  }

  /**
   * Применяет результат извлечения к слоям. Детектит предложение новой задачи,
   * пишет факты задачи и явные предпочтения. Возвращает, что именно записано.
   */
  private applyExtraction(content: string): { taskUpdated: boolean; profileAdded: string[] } {
    let parsed: { task?: unknown; user?: unknown; isNewTask?: unknown; proposedTitle?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      return { taskUpdated: false, profileAdded: [] }; // невалидный JSON — пропускаем ход
    }
    // Авто-определение новой задачи: предлагаем, если уверены, тема отличается от
    // текущей и пользователь раньше от такого имени не отказывался.
    const proposedTitle =
      typeof parsed.proposedTitle === 'string' ? parsed.proposedTitle.trim() : '';
    if (
      parsed.isNewTask === true &&
      proposedTitle.length > 0 &&
      proposedTitle !== this.tasks.current()?.title &&
      !this.declined.has(proposedTitle)
    ) {
      this.proposal = proposedTitle;
    }
    const taskUpdated = Array.isArray(parsed.task) ? this.tasks.applyDetails(parsed.task) : false;
    const profileAdded = Array.isArray(parsed.user) ? this.profiles.addTraits(parsed.user) : [];
    return { taskUpdated, profileAdded };
  }

  /**
   * Наблюдает за новыми репликами: извлекает факты задачи и явные предпочтения,
   * детектит новую задачу (предложение можно забрать через takeProposal). Делается
   * ДО ответа модели — чтобы подтверждённая задача попала в контекст этого же хода.
   */
  async observe(
    messages: ChatMessage[],
    onExtraction?: (usage: Usage | undefined) => void,
  ): Promise<MemoryWriteReport | null> {
    if (!this.enabled) {
      return null;
    }
    const conversation = messages.slice(1);
    const newMessages = conversation.slice(this.extractedThrough);
    if (newMessages.length === 0) {
      return null;
    }
    try {
      const result = await this.extract(newMessages);
      const applied = this.applyExtraction(result.content);
      this.extractedThrough = conversation.length;
      onExtraction?.(result.usage);
      const task = this.tasks.current();
      return {
        usage: result.usage,
        taskTitle: applied.taskUpdated && task !== null ? task.title : null,
        taskFactCount: task !== null ? task.details.length : 0,
        profileAdded: applied.profileAdded,
        consolidated: null,
      };
    } catch {
      // Извлечение не удалось — оставляем прежнюю память, повторим в следующий ход.
      return null;
    }
  }

  /**
   * Собирает сообщения для запроса: прогоняет короткую стратегию и подмешивает
   * блоки профиля и задачи + директиву (без обращения к модели за памятью).
   */
  async build(
    messages: ChatMessage[],
    onCompression?: (usage: Usage | undefined) => void,
  ): Promise<ChatMessage[]> {
    const shortened = await this.strategy.prepare(messages, onCompression);
    if (!this.enabled) {
      return shortened;
    }
    const system: ChatMessage = {
      role: 'system',
      content: `${shortened[0].content}\n\n${PERSONALIZATION_DIRECTIVE}`,
    };
    const blocks: ChatMessage[] = [];
    const profile = this.profiles.block(this.budgets.profile);
    if (profile) blocks.push(profile);
    const task = this.tasks.block(this.budgets.task);
    if (task) blocks.push(task);
    return [system, ...blocks, ...shortened.slice(1)];
  }

  /** Наблюдение + сборка одним вызовом (наблюдение раньше сборки). */
  async prepare(
    messages: ChatMessage[],
    onCompression?: (usage: Usage | undefined) => void,
    onExtraction?: (usage: Usage | undefined) => void,
  ): Promise<ChatMessage[]> {
    await this.observe(messages, onExtraction);
    return this.build(messages, onCompression);
  }

  /** Консолидирует устойчивые черты пользователя в профиль (в конце сессии). */
  async consolidate(
    messages: ChatMessage[],
    onExtraction?: (usage: Usage | undefined) => void,
  ): Promise<MemoryWriteReport | null> {
    const conversation = messages.slice(1);
    // Профиль строим ТОЛЬКО из реплик пользователя — чтобы не впитать предложения
    // и допущения модели как «предпочтения пользователя».
    const userMessages = conversation.filter(message => message.role === 'user');
    if (!this.enabled || userMessages.length === 0) {
      return null;
    }
    const dialogue = userMessages.map(message => `Пользователь: ${message.content}`).join('\n');
    const profileTexts = this.profiles.entries();
    const known = profileTexts.length > 0 ? `Текущий профиль:\n${profileTexts.join('\n')}\n\n` : '';
    const instruction =
      known +
      'Ниже — реплики ПОЛЬЗОВАТЕЛЯ. Сформируй долговременный профиль из УСТОЙЧИВЫХ ' +
      'черт пользователя, общих для разных задач: предпочтения по форме/стилю ответов, ' +
      'язык общения, привычные инструменты и подходы. ИСКЛЮЧИ параметры конкретного ' +
      'проекта/задачи (бюджет, сроки, название проекта, выбранные под эту задачу ' +
      'технологии) и разовые факты — это не про пользователя вообще. Не добавляй того, ' +
      'чего пользователь сам не утверждал. Слей дубли. Верни ТОЛЬКО список, по одному ' +
      'факту на строку.\n\nРеплики:\n' +
      dialogue;
    try {
      const result = await this.client.completeWithUsage([{ role: 'user', content: instruction }], {
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        disableThinking: true,
        maxTokens: this.budgets.profile,
      });
      const texts = result.content
        .split('\n')
        .map(line => line.replace(/^[-*\s]+/, '').trim())
        .filter(line => line.length > 0);
      if (texts.length > 0) {
        this.profiles.replace(texts);
      }
      onExtraction?.(result.usage);
      return {
        usage: result.usage,
        taskTitle: null,
        taskFactCount: 0,
        profileAdded: [],
        consolidated: texts.length,
      };
    } catch {
      // Консолидация не удалась — профиль остаётся прежним.
      return null;
    }
  }
}
