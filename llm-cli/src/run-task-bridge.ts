import type { Session, Task } from '../../core/src/index.ts';
import type { RunTaskBridge } from './run-flow.ts';
import { formatRunContext } from './formatters.ts';

/**
 * Узкий фасад памяти задач, нужный мосту прогонов — ровно то, что использует
 * MemoryRunBridge. MemoryManager удовлетворяет ему структурно (DIP: мост зависит
 * от контракта, а не от менеджера целиком — это упрощает тесты).
 */
export interface TaskMemoryFacade {
  currentTask(): Task | null;
  switchTask(idOrName: string): Task | null;
  setTask(title: string): Task;
  adopt(taskId: string | undefined): void;
  addTaskDetail(idOrName: string, detail: string): Task | null;
  markTaskDone(idOrName: string): Task | null;
  profileEntries(): string[];
}

/** Параметры моста: фасад памяти + доступ к текущей сессии (её taskId синхронизируем). */
export interface MemoryRunBridgeDeps {
  memory: TaskMemoryFacade;
  /** Текущая сессия (геттер: ветка/переключение могут её менять). */
  session: () => Session;
  /** Сохранить сессию (null при --ephemeral — no-op у вызывающего). */
  saveSession: (session: Session) => void;
}

/**
 * Связывает прогон пайплайна с задачей сессии: задача — единая сущность, прогон —
 * её исполнение. На вход этапам отдаёт память задачи (детали + профиль), на выходе
 * пишет итог в детали и помечает задачу выполненной. Синхронизирует session.taskId.
 */
export class MemoryRunBridge implements RunTaskBridge {
  private readonly deps: MemoryRunBridgeDeps;

  constructor(deps: MemoryRunBridgeDeps) {
    this.deps = deps;
  }

  current(): Task | null {
    return this.deps.memory.currentTask();
  }

  resolveOrCreate(arg: string): Task {
    const task = this.deps.memory.switchTask(arg) ?? this.deps.memory.setTask(arg);
    this.bindSession(task.id);
    return task;
  }

  adopt(taskId: string): void {
    this.deps.memory.adopt(taskId);
    this.bindSession(taskId);
  }

  memoryContext(): string {
    const task = this.deps.memory.currentTask();
    return formatRunContext(task === null ? [] : task.details, this.deps.memory.profileEntries());
  }

  complete(summary: string): boolean {
    const task = this.deps.memory.currentTask();
    if (task === null) {
      return false;
    }
    if (summary) {
      this.deps.memory.addTaskDetail(task.id, `Итог: ${summary}`);
    }
    this.deps.memory.markTaskDone(task.id);
    const session = this.deps.session();
    if (session.taskId === task.id) {
      session.taskId = undefined; // выполненная задача больше не привязана к сессии
      this.deps.saveSession(session);
    }
    return true;
  }

  /** Делает задачу активной задачей сессии и сохраняет указатель. */
  private bindSession(taskId: string): void {
    const session = this.deps.session();
    session.taskId = taskId;
    this.deps.saveSession(session);
  }
}
