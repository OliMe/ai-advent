import type { ChatCompletionClient, ChatMessage } from '../../core/src/index.ts';

/** Одно решение задачи: подпись метода и текст. */
export interface Solution {
  label: string;
  text: string;
}

/** Итог: все решения и оценка GLM, какое из них точнее. */
export interface SolveResult {
  solutions: Solution[];
  verdict: string;
}

/** Разбирает список экспертов из строки «через запятую». */
export function parseExperts(raw: string): string[] {
  return raw
    .split(',')
    .map(expert => expert.trim())
    .filter(expert => expert.length > 0);
}

/** Способ 1: простой запрос. */
export function buildSimpleMessages(task: string): ChatMessage[] {
  return [{ role: 'user', content: task }];
}

/** Способ 2: требование пошагового решения. */
export function buildStepByStepMessages(task: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: 'Реши задачу пошагово, подробно расписывая каждый шаг рассуждений.',
    },
    { role: 'user', content: task },
  ];
}

/** Способ 3, шаг 1: попросить GLM составить промпт для решения (без самого решения). */
export function buildPromptCraftMessages(task: string): ChatMessage[] {
  return [
    {
      role: 'user',
      content:
        'Составь максимально качественный промпт, который поможет образцово решить ' +
        'задачу ниже. Верни только текст промпта, саму задачу не решай.\n\n' +
        `Задача:\n${task}`,
    },
  ];
}

/** Способ 3, шаг 2: решить задачу по составленному промпту. */
export function buildSolveWithPromptMessages(craftedPrompt: string, task: string): ChatMessage[] {
  return [
    { role: 'system', content: craftedPrompt },
    { role: 'user', content: task },
  ];
}

/** Способ 4: панель экспертов (состав задаёт пользователь). */
export function buildExpertPanelMessages(task: string, experts: string[]): ChatMessage[] {
  const panel =
    experts.length > 0 ? experts.join(', ') : 'подходящих под задачу экспертов (подбери сам)';
  return [
    {
      role: 'system',
      content:
        `Ты ведёшь обсуждение группы экспертов: ${panel}. Пусть каждый эксперт кратко ` +
        'выскажется по задаче со своей точки зрения, затем выработайте общее обоснованное решение.',
    },
    { role: 'user', content: task },
  ];
}

/** Финальный запрос: оценить решения и выбрать самое точное. */
export function buildEvaluationMessages(task: string, solutions: Solution[]): ChatMessage[] {
  const body = solutions
    .map((solution, index) => `### Решение ${index + 1}. ${solution.label}\n${solution.text}`)
    .join('\n\n');
  return [
    { role: 'system', content: 'Ты — беспристрастный эксперт-судья.' },
    {
      role: 'user',
      content:
        `Задача:\n${task}\n\nНиже несколько решений, полученных разными способами. ` +
        'Определи, какое из них наиболее точное и корректное, и объясни почему. ' +
        `Явно назови лучшее решение.\n\n${body}`,
    },
  ];
}

/** Выполняет один запрос к модели с таймаутом. */
async function ask(
  client: ChatCompletionClient,
  messages: ChatMessage[],
  requestTimeoutMs: number,
): Promise<string> {
  const signal = AbortSignal.timeout(requestTimeoutMs);
  return client.complete(messages, { signal });
}

/** Решает задачу всеми четырьмя способами и просит GLM оценить результаты. */
export async function solveAll(
  client: ChatCompletionClient,
  task: string,
  experts: string[],
  requestTimeoutMs: number,
): Promise<SolveResult> {
  // Независимые запросы выполняем параллельно. У GLM-5.1 лимит конкурентности
  // достаточный (10); при более строгих лимитах лишние 429 поглощаются ретраями
  // в ядре. Сюда же — шаг 1 двухшагового способа (составление промпта).
  const [simple, stepByStep, expertPanel, craftedPrompt] = await Promise.all([
    ask(client, buildSimpleMessages(task), requestTimeoutMs),
    ask(client, buildStepByStepMessages(task), requestTimeoutMs),
    ask(client, buildExpertPanelMessages(task, experts), requestTimeoutMs),
    ask(client, buildPromptCraftMessages(task), requestTimeoutMs),
  ]);

  // Шаг 2 двухшагового способа зависит от составленного промпта — только после него.
  const twoStep = await ask(
    client,
    buildSolveWithPromptMessages(craftedPrompt, task),
    requestTimeoutMs,
  );

  const solutions: Solution[] = [
    { label: 'Простой запрос', text: simple },
    { label: 'Пошаговое решение', text: stepByStep },
    { label: 'Двухшаговый (промпт → решение)', text: twoStep },
    { label: 'Панель экспертов', text: expertPanel },
  ];

  // Оценка — после того, как готовы все решения.
  const verdict = await ask(client, buildEvaluationMessages(task, solutions), requestTimeoutMs);
  return { solutions, verdict };
}

/** Форматирует итог для вывода в консоль. */
export function formatResult(result: SolveResult): string {
  const blocks = result.solutions.map(
    (solution, index) => `[${index + 1}] ${solution.label}\n${solution.text}`,
  );
  return `${blocks.join('\n\n')}\n\n=== Оценка GLM ===\n${result.verdict}\n`;
}
