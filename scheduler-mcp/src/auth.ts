/**
 * Требуемый bearer-токен из окружения. Пусто/не задан — авторизация выключена (открытый
 * доступ; допустимо за доверенным реверс-прокси, но НЕ для публичного VPS).
 */
export function requiredBearerToken(env: NodeJS.ProcessEnv): string | undefined {
  const token = env.MCP_BEARER_TOKEN?.trim();
  return token ? token : undefined;
}

/**
 * Проверяет заголовок Authorization против ожидаемого токена. Токен не задан → доступ
 * открыт (true). Иначе требуется ровно `Bearer <токен>`.
 */
export function authorize(authorization: string | undefined, token: string | undefined): boolean {
  if (token === undefined) {
    return true;
  }
  return authorization === `Bearer ${token}`;
}
