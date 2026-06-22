/** Описание запуска MCP-сервера по stdio: команда, аргументы и окружение процесса. */
export interface StdioLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Возвращает обязательный ключ Tavily из окружения; бросает ошибку, если он не задан. */
export function resolveTavilyApiKey(env: NodeJS.ProcessEnv): string {
  const apiKey = env.TAVILY_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Не задан TAVILY_API_KEY. Запуск: TAVILY_API_KEY=tvly-... npm run list-tools');
  }
  return apiKey;
}

/** Системные переменные, пробрасываемые серверу: npx нужен PATH и каталог кэша (HOME/APPDATA). */
const FORWARDED_ENVIRONMENT_NAMES = ['PATH', 'HOME', 'APPDATA'] as const;

/** Окружение дочернего процесса сервера: ключ Tavily + проброшенные системные переменные. */
export function serverEnvironment(apiKey: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = { TAVILY_API_KEY: apiKey };
  for (const name of FORWARDED_ENVIRONMENT_NAMES) {
    const value = env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

/** Параметры запуска MCP-сервера Tavily по stdio (через npx) с подготовленным окружением. */
export function tavilyServerParameters(apiKey: string, env: NodeJS.ProcessEnv): StdioLaunch {
  return { command: 'npx', args: ['-y', 'tavily-mcp'], env: serverEnvironment(apiKey, env) };
}
