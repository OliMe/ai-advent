/**
 * Проверяет заголовок Authorization против списка разрешённых токенов.
 * Пустой список — авторизация выключена, доступ открыт.
 */
export function authorize(authorization: string | undefined, allowedTokens: string[]): boolean {
  if (allowedTokens.length === 0) {
    return true;
  }
  const presented = extractBearerToken(authorization);
  if (presented === undefined) {
    return false;
  }
  return allowedTokens.includes(presented);
}

/** Достаёт токен из заголовка вида `Bearer <токен>`; иначе — undefined. */
export function extractBearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined) {
    return undefined;
  }
  const prefix = 'Bearer ';
  if (!authorization.startsWith(prefix)) {
    return undefined;
  }
  const token = authorization.slice(prefix.length).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Ключ, по которому считается rate limit: сам токен, если он предъявлен, иначе
 * адрес клиента (режим без авторизации).
 */
export function rateLimitIdentity(
  authorization: string | undefined,
  remoteAddress: string,
): string {
  const token = extractBearerToken(authorization);
  return token === undefined ? `ip:${remoteAddress}` : `token:${token}`;
}
