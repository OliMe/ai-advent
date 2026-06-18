import { createTask, summarizeTask } from './task-store.ts';
import type { Task, TaskStore, TaskSummary } from './task-store.ts';
import type { ChatMessage } from './types.ts';
import { capToBudget } from './tokens.ts';

/**
 * Задачный слой памяти: владеет активной задачей, её хранилищем и индексом задач
 * процесса (для in-memory режима без диска). Создание/переключение/закрытие/
 * удаление задач, применение извлечённых фактов и рендер блока для контекста.
 */
export class TaskMemory {
  private readonly store: TaskStore | null;
  private task: Task | null = null;
  // Индекс задач этого процесса (нужен для in-memory режима без хранилища).
  private readonly tasks = new Map<string, Task>();

  constructor(store: TaskStore | null) {
    this.store = store;
  }

  /** Текущая активная задача (или null). */
  current(): Task | null {
    return this.task;
  }

  /** Сохраняет задачу в хранилище (если есть) и в индекс процесса. */
  private persist(task: Task): void {
    this.tasks.set(task.id, task);
    this.store?.save(task);
  }

  /** Создаёт новую активную задачу и делает её текущей. */
  set(title: string): Task {
    const task = createTask(title);
    this.task = task;
    this.persist(task);
    return task;
  }

  /** Список задач (из хранилища или из памяти процесса), свежие первыми. */
  list(): TaskSummary[] {
    if (this.store !== null) {
      return this.store.list();
    }
    return [...this.tasks.values()]
      .map(summarizeTask)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Загружает задачу по id из хранилища или индекса процесса. */
  private loadById(id: string): Task | null {
    return this.store?.load(id) ?? this.tasks.get(id) ?? null;
  }

  /** Находит задачу по id или имени (id приоритетнее). */
  private find(idOrName: string): Task | null {
    const direct = this.loadById(idOrName);
    if (direct !== null) {
      return direct;
    }
    const match = this.list().find(summary => summary.title === idOrName);
    return match ? this.loadById(match.id) : null;
  }

  /** Делает активной существующую задачу (реактивирует завершённую). */
  switch(idOrName: string): Task | null {
    const task = this.find(idOrName);
    if (task === null) {
      return null;
    }
    if (task.status === 'done') {
      task.status = 'active';
      task.updatedAt = new Date().toISOString();
      this.persist(task);
    }
    this.task = task;
    return task;
  }

  /**
   * Привязывает слой к задаче сессии по её id (при resume/ветвлении/reset).
   * Нет id — активной задачи нет (предсказуемо для новой ветки).
   */
  adopt(taskId: string | undefined): void {
    this.task = taskId === undefined ? null : this.find(taskId);
  }

  /** Закрывает текущую задачу (помечает done); возвращает её имя или null. */
  close(): string | null {
    if (this.task === null) {
      return null;
    }
    const title = this.task.title;
    this.task.status = 'done';
    this.task.updatedAt = new Date().toISOString();
    this.persist(this.task);
    this.task = null;
    return title;
  }

  /** Удаляет задачу по id или имени; возвращает удалённую задачу или null. */
  delete(idOrName: string): Task | null {
    const task = this.find(idOrName);
    if (task === null) {
      return null;
    }
    this.tasks.delete(task.id);
    this.store?.delete(task.id);
    if (this.task?.id === task.id) {
      this.task = null; // удалили активную — снимаем
    }
    return task;
  }

  /** Находит задачу по id или имени без смены активной (или null). */
  get(idOrName: string): Task | null {
    return this.find(idOrName);
  }

  /** Дописывает один факт к задаче по id/имени; возвращает задачу или null. */
  addDetail(idOrName: string, detail: string): Task | null {
    const task = this.find(idOrName);
    if (task === null) {
      return null;
    }
    task.details.push(detail);
    task.updatedAt = new Date().toISOString();
    this.persist(task);
    return task;
  }

  /** Помечает задачу выполненной по id/имени; активную при этом снимает. */
  markDone(idOrName: string): Task | null {
    const task = this.find(idOrName);
    if (task === null) {
      return null;
    }
    task.status = 'done';
    task.updatedAt = new Date().toISOString();
    this.persist(task);
    if (this.task?.id === task.id) {
      this.task = null; // выполненная задача больше не активна
    }
    return task;
  }

  /**
   * Применяет извлечённые факты к активной задаче (с сохранением). Возвращает
   * true, если задача активна и факты записаны.
   */
  applyDetails(rawDetails: unknown[]): boolean {
    if (this.task === null) {
      return false;
    }
    this.task.details = rawDetails.filter((x): x is string => typeof x === 'string');
    this.task.updatedAt = new Date().toISOString();
    this.persist(this.task);
    return true;
  }

  /** Системный блок текущей задачи (или null, если задачи нет). */
  block(budgetTokens: number): ChatMessage | null {
    if (this.task === null) {
      return null;
    }
    const details =
      this.task.details.length > 0
        ? this.task.details.map(detail => `- ${detail}`).join('\n')
        : '(пока без деталей)';
    return {
      role: 'system',
      content: `Текущая задача: ${this.task.title}\n${capToBudget(details, budgetTokens)}`,
    };
  }
}
