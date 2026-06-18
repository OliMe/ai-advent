import type { ChatCompletionClient, CompletionResult } from './chat-completion-client.ts';
import type { ChatMessage, Usage } from './types.ts';
import { historyTokens, trimHistoryToBudget } from './tokens.ts';

/** Стратегия управления памятью диалога: окно, сжатие или блок фактов. */
export type MemoryKind = 'window' | 'summary' | 'facts';

/** Готовит сообщения для запроса к модели из полного транскрипта сессии. */
export interface MemoryStrategy {
  prepare(
    messages: ChatMessage[],
    onCompression?: (usage: Usage | undefined) => void,
  ): Promise<ChatMessage[]>;
  /** Сбрасывает состояние при смене сессии (/reset, /resume, /fork). */
  reset(): void;
}

/** Стратегия скользящего окна (по умолчанию): обрезка по бюджету, без вызовов модели. */
class WindowStrategy implements MemoryStrategy {
  private readonly budget: number;
  constructor(budget: number) {
    this.budget = budget;
  }
  async prepare(messages: ChatMessage[]): Promise<ChatMessage[]> {
    return trimHistoryToBudget(messages, this.budget);
  }
  reset(): void {}
}

/**
 * Потолок длины блока памяти (резюме или фактов), который генерирует модель:
 * компромисс между сохранностью данных и экономией. 256 было слишком агрессивно
 * (сильно резало факты), budget/4 — слишком дорого; 512 — баланс.
 */
const MEMORY_BLOCK_MAX_TOKENS = 512;

/**
 * Стратегия сжатия: последние N реплик хранятся дословно, всё, что старше,
 * сворачивается в системное резюме (отдельным вызовом модели). При сбое сжатия
 * на этот ход откатывается к окну.
 */
class SummaryStrategy implements MemoryStrategy {
  private readonly budget: number;
  private readonly recentCount: number;
  private readonly client: ChatCompletionClient;
  private readonly requestTimeoutMs: number;
  private summary = '';
  private summarizedCount = 0;

  constructor(
    budget: number,
    recentCount: number,
    client: ChatCompletionClient,
    requestTimeoutMs: number,
  ) {
    this.budget = budget;
    this.recentCount = recentCount;
    this.client = client;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  reset(): void {
    this.summary = '';
    this.summarizedCount = 0;
  }

  private summaryMessage(): ChatMessage | null {
    return this.summary
      ? { role: 'system', content: `Краткое содержание более раннего диалога: ${this.summary}` }
      : null;
  }

  /** Сворачивает реплики (с учётом прежнего резюме) в обновлённое резюме. */
  private async fold(spill: ChatMessage[]): Promise<CompletionResult> {
    const dialogue = spill
      .map(
        message =>
          `${message.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${message.content}`,
      )
      .join('\n');
    const instruction =
      (this.summary
        ? `Есть краткое содержание диалога:\n${this.summary}\n\nОбнови его, добавив реплики ниже. `
        : 'Сожми этот фрагмент диалога в краткое содержание. ') +
      'Сохрани факты, решения, имена и числа, без воды. Верни только краткое содержание:\n' +
      dialogue;
    const result = await this.client.completeWithUsage([{ role: 'user', content: instruction }], {
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      disableThinking: true,
      maxTokens: MEMORY_BLOCK_MAX_TOKENS,
    });
    this.summary = result.content.trim();
    return result;
  }

  async prepare(
    messages: ChatMessage[],
    onCompression?: (usage: Usage | undefined) => void,
  ): Promise<ChatMessage[]> {
    const systemMessage = messages[0];
    const conversation = messages.slice(1);
    // Дословно держим последние N реплик; всё, что старше, — в резюме.
    const keepFrom = Math.max(0, conversation.length - this.recentCount);
    try {
      const toFold = conversation.slice(this.summarizedCount, keepFrom);
      if (toFold.length > 0) {
        const result = await this.fold(toFold);
        this.summarizedCount = keepFrom;
        onCompression?.(result.usage);
      }
      const kept = conversation.slice(keepFrom);
      const summaryMsg = this.summaryMessage();
      return [systemMessage, ...(summaryMsg ? [summaryMsg] : []), ...kept];
    } catch {
      // Сжатие не удалось — мягко откатываемся к окну на этот ход.
      return trimHistoryToBudget(messages, this.budget);
    }
  }
}

/**
 * Стратегия «липких фактов»: отдельный блок «ключ: значение» (цель, ограничения,
 * предпочтения, решения, договорённости) обновляется моделью на каждом ходу и
 * отправляется вместе с последними N репликами. В отличие от summary, факты
 * обновляются всегда (не только при переполнении) и хранят структурированные
 * данные, а не пересказ. При сбое обновления оставляем прежние факты.
 */
class FactsStrategy implements MemoryStrategy {
  private readonly budget: number;
  private readonly recentCount: number;
  private readonly client: ChatCompletionClient;
  private readonly requestTimeoutMs: number;
  private facts = '';
  private factedThrough = 0;

  constructor(
    budget: number,
    recentCount: number,
    client: ChatCompletionClient,
    requestTimeoutMs: number,
  ) {
    this.budget = budget;
    this.recentCount = recentCount;
    this.client = client;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  reset(): void {
    this.facts = '';
    this.factedThrough = 0;
  }

  private factsMessage(): ChatMessage | null {
    return this.facts
      ? { role: 'system', content: `Известные факты о диалоге:\n${this.facts}` }
      : null;
  }

  /** Обновляет блок фактов с учётом новых реплик (с приоритетом слов пользователя). */
  private async update(spill: ChatMessage[]): Promise<CompletionResult> {
    const dialogue = spill
      .map(
        message =>
          `${message.role === 'assistant' ? 'Ассистент' : 'Пользователь'}: ${message.content}`,
      )
      .join('\n');
    const instruction =
      (this.facts
        ? `Текущие факты:\n${this.facts}\n\nОбнови их с учётом новых сообщений ниже. `
        : 'Извлеки ключевые факты из диалога ниже. ') +
      'Веди компактный список «ключ: значение»: цель, ограничения, предпочтения, ' +
      'решения, договорённости. Данные из реплик пользователя приоритетнее данных ' +
      'из ответов ассистента — при противоречии оставляй версию пользователя. ' +
      'Обновляй изменившееся, убирай устаревшее, без воды. Верни только список:\n' +
      dialogue;
    const result = await this.client.completeWithUsage([{ role: 'user', content: instruction }], {
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      disableThinking: true,
      maxTokens: MEMORY_BLOCK_MAX_TOKENS,
    });
    this.facts = result.content.trim();
    return result;
  }

  async prepare(
    messages: ChatMessage[],
    onCompression?: (usage: Usage | undefined) => void,
  ): Promise<ChatMessage[]> {
    const systemMessage = messages[0];
    const conversation = messages.slice(1);
    // Новые реплики с прошлого раза: предыдущий ответ ассистента + новый вопрос.
    const newMessages = conversation.slice(this.factedThrough);
    if (newMessages.length > 0) {
      try {
        const result = await this.update(newMessages);
        this.factedThrough = conversation.length;
        onCompression?.(result.usage);
      } catch {
        // Обновление не удалось — оставляем прежние факты, повторим в следующий ход.
      }
    }
    // Дословно держим последние N реплик; старое представлено блоком фактов.
    const keepFrom = Math.max(0, conversation.length - this.recentCount);
    const kept = conversation.slice(keepFrom);
    const factsMsg = this.factsMessage();
    const assembled = [systemMessage, ...(factsMsg ? [factsMsg] : []), ...kept];
    // Подстраховка: если факты + последние N всё же не влезают — обрезаем по окну.
    return historyTokens(assembled) > this.budget
      ? trimHistoryToBudget(assembled, this.budget)
      : assembled;
  }
}

/**
 * Создаёт стратегию памяти. Клиент сжатия инъектируется отдельно — это шов,
 * чтобы в будущем назначить более дешёвую/специализированную модель.
 */
export function createMemoryStrategy(
  kind: MemoryKind,
  budget: number,
  recentCount: number,
  summaryClient: ChatCompletionClient,
  requestTimeoutMs: number,
): MemoryStrategy {
  switch (kind) {
    case 'summary':
      return new SummaryStrategy(budget, recentCount, summaryClient, requestTimeoutMs);
    case 'facts':
      return new FactsStrategy(budget, recentCount, summaryClient, requestTimeoutMs);
    default:
      return new WindowStrategy(budget);
  }
}
