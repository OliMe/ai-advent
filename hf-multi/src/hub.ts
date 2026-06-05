/** Модель HuggingFace, отобранная для запроса. */
export interface HfModel {
  id: string;
  url: string;
  params: number;
  /** Провайдер инференса — закрепляем его в id (`<id>:<provider>`) для router'а. */
  provider: string;
}

const HUB_API = 'https://huggingface.co/api/models';

/** Ссылка на страницу модели на HuggingFace. */
export function modelUrl(id: string): string {
  return `https://huggingface.co/${id}`;
}

/**
 * Имя живого провайдера для chat-эндпоинта (task=conversational), либо null.
 * Router при «голом» id не всегда находит провайдера, поэтому его нужно
 * закреплять явно — для этого и достаём имя.
 */
function chatProvider(mapping: unknown): string | null {
  if (!Array.isArray(mapping)) {
    return null;
  }
  for (const entry of mapping) {
    const provider = entry as { provider?: unknown; task?: unknown; status?: unknown };
    if (
      provider.task === 'conversational' &&
      provider.status === 'live' &&
      typeof provider.provider === 'string'
    ) {
      return provider.provider;
    }
  }
  return null;
}

/**
 * Разбирает ответ HF Hub API в список моделей. Оставляет только те, у которых
 * известно число параметров (safetensors.total) и есть живой провайдер для
 * chat-эндпоинта — иначе base-модели падают на 400.
 */
export function parseCandidates(raw: unknown[]): HfModel[] {
  const models: HfModel[] = [];
  for (const item of raw) {
    const model = item as {
      id?: unknown;
      safetensors?: { total?: unknown };
      inferenceProviderMapping?: unknown;
    };
    const id = typeof model.id === 'string' ? model.id : null;
    const total = model.safetensors?.total;
    const params = typeof total === 'number' ? total : null;
    const provider = chatProvider(model.inferenceProviderMapping);
    if (id !== null && params !== null && provider !== null) {
      models.push({ id, url: modelUrl(id), params, provider });
    }
  }
  return models;
}

/**
 * Выбирает из списка по числу параметров: крупнейшую, среднюю и мельчайшую.
 * Если моделей три и меньше — возвращает все (по убыванию параметров).
 */
export function pickByParams(models: HfModel[]): HfModel[] {
  const sorted = [...models].sort((a, b) => b.params - a.params);
  if (sorted.length <= 3) {
    return sorted;
  }
  const middle = sorted[Math.floor((sorted.length - 1) / 2)];
  return [sorted[0], middle, sorted[sorted.length - 1]];
}

/** Запрашивает у HF Hub кандидатов (chat-модели по популярности) и разбирает их. */
export async function fetchCandidates(limit: number): Promise<HfModel[]> {
  const url =
    `${HUB_API}?pipeline_tag=text-generation&sort=downloads&limit=${limit}` +
    '&expand[]=safetensors&expand[]=inferenceProviderMapping';
  const response = await fetch(url, { headers: { 'User-Agent': 'ai-advent-hf-multi' } });
  if (!response.ok) {
    throw new Error(`HF Hub API вернул ошибку ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return parseCandidates(Array.isArray(data) ? data : []);
}

/** Подбирает тройку моделей по умолчанию: крупнейшая, средняя, мельчайшая. */
export async function selectDefaultModels(limit: number): Promise<HfModel[]> {
  return pickByParams(await fetchCandidates(limit));
}
