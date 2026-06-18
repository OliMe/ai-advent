import {
  createTask,
  emptyProfile,
  summarizeProfile,
  summarizeTask,
  DEFAULT_PROFILE_NAME,
} from '../../core/src/index.ts';
import type {
  ChatCompletionClient,
  ChatMessage,
  CompletionResult,
  Profile,
  ProfileStore,
  ProfileSummary,
  Task,
  TaskStore,
  TaskSummary,
  Usage,
} from '../../core/src/index.ts';
import type { MemoryStrategy } from './memory-strategy.ts';
import { CHARS_PER_TOKEN, MIN_HISTORY_BUDGET_TOKENS, estimateTokens } from './tokens.ts';

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

/** Обрезает текст до бюджета токенов (грубо, по символам), добавляя многоточие. */
function capToBudget(text: string, budgetTokens: number): string {
  if (estimateTokens(text) <= budgetTokens) {
    return text;
  }
  return text.slice(0, Math.max(0, budgetTokens * CHARS_PER_TOKEN - 1)) + '…';
}

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
 * Менеджер слоистой памяти: поверх короткой стратегии подмешивает в запрос
 * долговременный профиль пользователя и текущую задачу, обновляет их по ходу
 * диалога (извлечение фактов задачи + явные предпочтения) и консолидирует
 * профиль в конце сессии. Делает ответы персонализированными и нацеленными на
 * задачу. Хранилища = null — всё держим в памяти, на диск не пишем (--ephemeral).
 */
export class MemoryManager {
  readonly enabled: boolean;
  private readonly strategy: MemoryStrategy;
  private readonly budgets: LayerBudgets;
  private readonly client: ChatCompletionClient;
  private readonly requestTimeoutMs: number;
  private readonly profileStore: ProfileStore | null;
  private readonly taskStore: TaskStore | null;
  // Активный профиль (персона); его имя — profile.name.
  private profile: Profile;
  private task: Task | null = null;
  // Индексы этого процесса (нужны для in-memory режима без хранилища).
  private readonly tasks = new Map<string, Task>();
  private readonly profiles = new Map<string, Profile>();
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
    this.profile = options.profile;
    this.profileStore = options.profileStore;
    this.taskStore = options.taskStore;
    this.profiles.set(this.profile.name, this.profile); // in-memory кэш активного
  }

  /** Имя активного профиля (персоны). */
  currentProfileName(): string {
    return this.profile.name;
  }

  /** Сохраняет активный профиль (в хранилище или в индекс процесса). */
  private persistProfile(): void {
    if (this.profileStore !== null) {
      this.profileStore.save(this.profile);
    } else {
      this.profiles.set(this.profile.name, this.profile);
    }
  }

  /** Список профилей (из хранилища или из памяти процесса), свежие первыми. */
  listProfiles(): ProfileSummary[] {
    if (this.profileStore !== null) {
      return this.profileStore.list();
    }
    return [...this.profiles.values()]
      .map(summarizeProfile)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Есть ли профиль с таким именем. */
  private profileExists(name: string): boolean {
    return this.profileStore !== null
      ? this.profileStore.list().some(summary => summary.name === name)
      : this.profiles.has(name);
  }

  /**
   * Делает активным профиль с именем `name`, создавая пустой, если его нет.
   * Возвращает true, если профиль был создан. Активный профиль персистится глобально.
   */
  switchProfile(name: string): boolean {
    const created = !this.profileExists(name);
    this.profile =
      this.profileStore !== null
        ? this.profileStore.load(name)
        : (this.profiles.get(name) ?? emptyProfile(name));
    if (created) {
      this.persistProfile(); // создаём пустой, чтобы попал в список и активировался
    }
    this.profileStore?.setActive(name);
    return created;
  }

  /** Удаляет профиль из хранилища и индекса процесса. */
  private removeProfile(name: string): void {
    this.profiles.delete(name);
    this.profileStore?.delete(name);
  }

  /**
   * Удаляет профиль по имени. Если удалили активный — переключаемся на «default».
   * Возвращает true, если профиль существовал и был удалён.
   */
  deleteProfile(name: string): boolean {
    if (!this.profileExists(name)) {
      return false;
    }
    this.removeProfile(name);
    if (this.profile.name === name) {
      this.switchProfile(DEFAULT_PROFILE_NAME); // активный удалён — на default
    }
    return true;
  }

  /**
   * Переименовывает активный профиль. 'same' — имя не изменилось, 'taken' — имя
   * занято другим профилем, 'ok' — переименовано (старый файл удаляется).
   */
  renameProfile(newName: string): 'ok' | 'same' | 'taken' {
    const oldName = this.profile.name;
    if (newName === oldName) {
      return 'same';
    }
    if (this.profileExists(newName)) {
      return 'taken';
    }
    this.profile = { ...this.profile, name: newName, updatedAt: new Date().toISOString() };
    this.persistProfile(); // сохраняем под новым именем
    this.removeProfile(oldName); // убираем старый
    this.profileStore?.setActive(newName);
    return 'ok';
  }

  /** Текущая активная задача (или null). */
  currentTask(): Task | null {
    return this.task;
  }

  /** Пункты профиля пользователя. */
  profileEntries(): string[] {
    return this.profile.entries.map(entry => entry.text);
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

  /** Сохраняет задачу в хранилище (если есть) и в индекс процесса. */
  private persistTask(task: Task): void {
    this.tasks.set(task.id, task);
    this.taskStore?.save(task);
  }

  /** Создаёт новую активную задачу и делает её текущей. */
  setTask(title: string): Task {
    const task = createTask(title);
    this.task = task;
    this.proposal = null; // задача выбрана — снимаем висящее предложение
    this.persistTask(task);
    return task;
  }

  /** Список задач (из хранилища или из памяти процесса), свежие первыми. */
  listTasks(): TaskSummary[] {
    if (this.taskStore !== null) {
      return this.taskStore.list();
    }
    return [...this.tasks.values()]
      .map(summarizeTask)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Загружает задачу по id из хранилища или индекса процесса. */
  private loadById(id: string): Task | null {
    return this.taskStore?.load(id) ?? this.tasks.get(id) ?? null;
  }

  /** Находит задачу по id или имени (id приоритетнее). */
  private findTask(idOrName: string): Task | null {
    const direct = this.loadById(idOrName);
    if (direct !== null) {
      return direct;
    }
    const match = this.listTasks().find(summary => summary.title === idOrName);
    return match ? this.loadById(match.id) : null;
  }

  /** Делает активной существующую задачу (реактивирует завершённую). */
  switchTask(idOrName: string): Task | null {
    const task = this.findTask(idOrName);
    if (task === null) {
      return null;
    }
    if (task.status === 'done') {
      task.status = 'active';
      task.updatedAt = new Date().toISOString();
      this.persistTask(task);
    }
    this.task = task;
    return task;
  }

  /**
   * Привязывает менеджер к задаче сессии по её id (при resume/ветвлении/reset).
   * Нет id — активной задачи нет (предсказуемо для новой ветки).
   */
  adopt(taskId: string | undefined): void {
    this.task = taskId === undefined ? null : this.findTask(taskId);
  }

  /** Закрывает текущую задачу (помечает done); возвращает её имя или null. */
  closeTask(): string | null {
    if (this.task === null) {
      return null;
    }
    const title = this.task.title;
    this.task.status = 'done';
    this.task.updatedAt = new Date().toISOString();
    this.persistTask(this.task);
    this.task = null;
    return title;
  }

  /** Удаляет задачу по id или имени; возвращает удалённую задачу или null. */
  deleteTask(idOrName: string): Task | null {
    const task = this.findTask(idOrName);
    if (task === null) {
      return null;
    }
    this.tasks.delete(task.id);
    this.taskStore?.delete(task.id);
    if (this.task?.id === task.id) {
      this.task = null; // удалили активную — снимаем
    }
    return task;
  }

  /**
   * Забывает пункты профиля по номерам (1-based). Резолвит индексы ДО удаления,
   * чтобы их сдвиг не мешал; невалидные игнорирует. Возвращает забытые тексты
   * (в порядке возрастания номера).
   */
  forgetProfile(oneBasedIndices: number[]): string[] {
    const drop = new Set<number>();
    for (const oneBased of oneBasedIndices) {
      const index = oneBased - 1;
      if (index >= 0 && index < this.profile.entries.length) {
        drop.add(index);
      }
    }
    if (drop.size === 0) {
      return [];
    }
    const removed = [...drop].sort((a, b) => a - b).map(index => this.profile.entries[index].text);
    this.profile.entries = this.profile.entries.filter((_, index) => !drop.has(index));
    this.profile.updatedAt = new Date().toISOString();
    this.persistProfile();
    return removed;
  }

  /** Системный блок профиля (или null, если пусто/выключено). */
  private profileBlock(): ChatMessage | null {
    if (!this.enabled || this.profile.entries.length === 0) {
      return null;
    }
    const body = capToBudget(
      this.profile.entries.map(entry => `- ${entry.text}`).join('\n'),
      this.budgets.profile,
    );
    return { role: 'system', content: `Профиль пользователя:\n${body}` };
  }

  /** Системный блок текущей задачи (или null, если задачи нет/выключено). */
  private taskBlock(): ChatMessage | null {
    if (!this.enabled || this.task === null) {
      return null;
    }
    const details =
      this.task.details.length > 0
        ? this.task.details.map(d => `- ${d}`).join('\n')
        : '(пока без деталей)';
    return {
      role: 'system',
      content: `Текущая задача: ${this.task.title}\n${capToBudget(details, this.budgets.task)}`,
    };
  }

  /** Извлекает из новых реплик факты задачи и явные предпочтения (один вызов). */
  private async extract(newMessages: ChatMessage[]): Promise<CompletionResult> {
    const dialogue = newMessages
      .map(m => `${m.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${m.content}`)
      .join('\n');
    const taskContext =
      this.task !== null
        ? `Текущая задача: ${this.task.title}\nИзвестные факты задачи:\n${this.task.details.join('\n')}\n\n`
        : 'Активной задачи нет.\n\n';
    const profileContext =
      this.profile.entries.length > 0
        ? `Уже известно о пользователе:\n${this.profile.entries.map(e => e.text).join('\n')}\n\n`
        : '';
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
   * Применяет результат извлечения к задаче и профилю (с сохранением). Возвращает,
   * что именно записано: обновлена ли задача и какие пункты добавлены в профиль.
   */
  private applyExtraction(content: string): { taskUpdated: boolean; profileAdded: string[] } {
    let parsed: { task?: unknown; user?: unknown; isNewTask?: unknown; proposedTitle?: unknown };
    try {
      parsed = JSON.parse(content);
    } catch {
      return { taskUpdated: false, profileAdded: [] }; // невалидный JSON — пропускаем ход
    }
    const now = new Date().toISOString();
    // Авто-определение новой задачи: предлагаем, если уверены, тема отличается от
    // текущей и пользователь раньше от такого имени не отказывался.
    const proposedTitle =
      typeof parsed.proposedTitle === 'string' ? parsed.proposedTitle.trim() : '';
    if (
      parsed.isNewTask === true &&
      proposedTitle.length > 0 &&
      proposedTitle !== this.task?.title &&
      !this.declined.has(proposedTitle)
    ) {
      this.proposal = proposedTitle;
    }
    let taskUpdated = false;
    if (this.task !== null && Array.isArray(parsed.task)) {
      this.task.details = parsed.task.filter((x): x is string => typeof x === 'string');
      this.task.updatedAt = now;
      this.persistTask(this.task);
      taskUpdated = true;
    }
    const profileAdded: string[] = [];
    if (Array.isArray(parsed.user)) {
      const known = new Set(this.profile.entries.map(entry => entry.text));
      for (const trait of parsed.user) {
        if (typeof trait === 'string' && trait.trim() && !known.has(trait.trim())) {
          this.profile.entries.push({ text: trait.trim(), updatedAt: now });
          known.add(trait.trim());
          profileAdded.push(trait.trim());
        }
      }
      if (profileAdded.length > 0) {
        this.profile.updatedAt = now;
        this.persistProfile();
      }
    }
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
      return {
        usage: result.usage,
        taskTitle: applied.taskUpdated && this.task !== null ? this.task.title : null,
        taskFactCount: this.task !== null ? this.task.details.length : 0,
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
    const profile = this.profileBlock();
    if (profile) blocks.push(profile);
    const task = this.taskBlock();
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
    const known =
      this.profile.entries.length > 0
        ? `Текущий профиль:\n${this.profile.entries.map(e => e.text).join('\n')}\n\n`
        : '';
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
      const now = new Date().toISOString();
      const entries = result.content
        .split('\n')
        .map(line => line.replace(/^[-*\s]+/, '').trim())
        .filter(line => line.length > 0)
        .map(text => ({ text, updatedAt: now }));
      if (entries.length > 0) {
        this.profile = { ...this.profile, entries, updatedAt: now };
        this.persistProfile();
      }
      onExtraction?.(result.usage);
      return {
        usage: result.usage,
        taskTitle: null,
        taskFactCount: 0,
        profileAdded: [],
        consolidated: entries.length,
      };
    } catch {
      // Консолидация не удалась — профиль остаётся прежним.
      return null;
    }
  }
}
