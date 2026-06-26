import type { ElicitationHandler } from '../../mcp-client/src/index.ts';

/** Запрос подтверждения у пользователя (да/нет) по тексту сообщения. */
export type ConfirmPrompt = (message: string) => Promise<boolean>;

/**
 * Мост между MCP-elicitation и пользователем. Обработчик создаётся рано (для McpToolSet), а
 * реальный запрос к пользователю подставляется позже (когда готов ввод readline) через setConfirm.
 * Пока запрос не подставлен — безопасный отказ (decline), чтобы операция вне песочницы не прошла.
 */
export class ElicitationBridge {
  private confirm: ConfirmPrompt | null = null;

  /** Подставляет реальный запрос подтверждения (вызывается после инициализации ввода). */
  setConfirm(confirm: ConfirmPrompt): void {
    this.confirm = confirm;
  }

  /** Обработчик для mcp-client: переадресует серверный запрос подтверждения пользователю. */
  readonly handler: ElicitationHandler = async ({ message }) => {
    if (this.confirm === null) {
      return { action: 'decline' };
    }
    return { action: (await this.confirm(message)) ? 'accept' : 'decline' };
  };
}

/**
 * Строит запрос подтверждения поверх функции вопроса (readline.question) и проверки
 * утвердительности ответа: печатает предупреждение и возвращает true только на «да».
 */
export function readlineConfirm(
  question: (prompt: string) => Promise<string>,
  isAffirmative: (reply: string) => boolean,
): ConfirmPrompt {
  return async message =>
    isAffirmative((await question(`\n⚠ ${message} (да/нет) `)).trim().toLowerCase());
}
