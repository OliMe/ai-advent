import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { ChatCompletionClient } from '../../core/src/index.ts';
import { formatAnswerCost } from './answer-cost.ts';
import { authorize, rateLimitIdentity } from './auth.ts';
import { ChatService, PromptTooLargeError, createUpstreamConfig } from './chat-service.ts';
import type { GatewayConfig } from './config.ts';
import { DEFAULT_PERSONA, PERSONAS, findPersona, type Persona } from './personas.ts';
import { TokenBucketRateLimiter } from './rate-limit.ts';
import { QueueOverflowError, RequestQueue } from './request-queue.ts';
import { CpuIdleTracker, readSystemMetrics, type ProcFileSource } from './system-metrics.ts';

/** Читает /proc реальной машины. На macOS этих файлов нет — шлюз рассчитан на Linux. */
const PROC_SOURCE: ProcFileSource = {
  readStat: () => readFileSync('/proc/stat', 'utf8'),
  readMemInfo: () => readFileSync('/proc/meminfo', 'utf8'),
  readLoadAverage: () => readFileSync('/proc/loadavg', 'utf8'),
};

/** Собирает HTTP-обработчик шлюза со всеми зависимостями. */
export function createGatewayHandler(config: GatewayConfig) {
  const queue = new RequestQueue(config.maxQueueDepth);
  const rateLimiter = new TokenBucketRateLimiter(
    config.rateLimitCapacity,
    config.rateLimitRefillPerMinute,
  );
  const cpuTracker = new CpuIdleTracker();

  const chatService = new ChatService({
    config,
    queue,
    createClient: model => new ChatCompletionClient(createUpstreamConfig(config, model)),
    now: () => Date.now(),
  });

  const pageTemplate = readFileSync(join(import.meta.dirname, 'public', 'index.html'), 'utf8');

  const sendJson = (response: ServerResponse, status: number, body: unknown) => {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    response.end(payload);
  };

  const renderPage = (response: ServerResponse, persona: Persona) => {
    const html = pageTemplate
      .replaceAll('{{SLUG}}', persona.slug)
      .replaceAll('{{TITLE}}', persona.title)
      .replaceAll('{{MODEL}}', persona.model)
      .replaceAll('{{HINT}}', persona.inputHint)
      .replaceAll('{{BASE}}', config.basePath);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
  };

  const readBody = async (request: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  };

  /** Проверяет только токен. Вернёт false, если ответ уже отправлен. */
  const passesAuth = (request: IncomingMessage, response: ServerResponse): boolean => {
    if (!authorize(request.headers.authorization, config.bearerTokens)) {
      sendJson(response, 401, { error: 'Нужен заголовок Authorization: Bearer <токен>.' });
      return false;
    }
    return true;
  };

  /**
   * Ворота запросов к модели: токен плюс rate limit. Пульс через них НЕ ходит — интерфейс
   * опрашивает его чаще, чем пополняется ведро, и съедал бы лимит впустую.
   */
  const passesGate = (request: IncomingMessage, response: ServerResponse): boolean => {
    if (!passesAuth(request, response)) {
      return false;
    }
    const authorization = request.headers.authorization;
    const identity = rateLimitIdentity(authorization, request.socket.remoteAddress ?? 'неизвестно');
    const decision = rateLimiter.consume(identity);
    if (!decision.allowed) {
      response.setHeader('Retry-After', String(decision.retryAfterSeconds));
      sendJson(response, 429, {
        error: 'Слишком часто. Узел один, дайте ему выдохнуть.',
        retryAfterSeconds: decision.retryAfterSeconds,
      });
      return false;
    }
    response.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    return true;
  };

  /** Отдаёт состояние узла: метрики, очередь, действующие лимиты. */
  const handlePulse = (response: ServerResponse) => {
    const metrics = readSystemMetrics(PROC_SOURCE, cpuTracker);
    sendJson(response, 200, {
      metrics: {
        cpuIdlePercent: Math.round(metrics.cpuIdlePercent),
        loadAverage1m: metrics.loadAverage1m,
        memoryAvailablePercent: Math.round(metrics.memoryAvailableRatio * 100),
      },
      queue: { depth: queue.depth, maxDepth: config.maxQueueDepth },
      limits: {
        maxPromptTokens: config.maxPromptTokens,
        rateLimitCapacity: config.rateLimitCapacity,
        rateLimitRefillPerMinute: config.rateLimitRefillPerMinute,
      },
    });
  };

  /** Поток ответа персоны в формате Server-Sent Events. */
  const handleChat = async (
    request: IncomingMessage,
    response: ServerResponse,
    persona: Persona,
  ) => {
    const body = await readBody(request);
    const message = String(JSON.parse(body).message ?? '');

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const emit = (event: string, data: unknown) => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const outcome = await chatService.respond(persona, message, {
        onQueued: waitingAhead => emit('queued', { waitingAhead }),
        onDelta: text => emit('delta', { text }),
      });
      emit('done', { cost: outcome.cost, costText: formatAnswerCost(outcome.cost) });
    } catch (error) {
      emit('failed', { error: describeError(error) });
    }
    response.end();
  };

  /** OpenAI-совместимый эндпоинт: `model` — это slug персоны. */
  const handleOpenAiCompletions = async (request: IncomingMessage, response: ServerResponse) => {
    const body = JSON.parse(await readBody(request)) as {
      model?: string;
      messages?: { role: string; content: string }[];
    };
    const persona = findPersona(body.model ?? '');
    if (persona === undefined) {
      sendJson(response, 404, {
        error: `Неизвестная модель. Доступны: ${PERSONAS.map(item => item.slug).join(', ')}.`,
      });
      return;
    }
    const lastUserMessage = [...(body.messages ?? [])].reverse().find(item => item.role === 'user');
    if (lastUserMessage === undefined) {
      sendJson(response, 400, { error: 'В messages нет сообщения с role: "user".' });
      return;
    }

    try {
      const outcome = await chatService.respond(persona, lastUserMessage.content, {
        onQueued: () => undefined,
        onDelta: () => undefined,
      });
      sendJson(response, 200, {
        object: 'chat.completion',
        model: persona.slug,
        choices: [{ index: 0, message: { role: 'assistant', content: outcome.content } }],
        node_cost: outcome.cost,
      });
    } catch (error) {
      sendJson(response, statusForError(error), { error: describeError(error) });
    }
  };

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '');

    if (request.method === 'GET' && (path === '' || path === '/')) {
      response.writeHead(302, { Location: `${config.basePath}/${DEFAULT_PERSONA.slug}` });
      response.end();
      return;
    }

    const persona = findPersona(path.slice(1));
    if (request.method === 'GET' && persona !== undefined) {
      renderPage(response, persona);
      return;
    }

    if (request.method === 'GET' && path === '/api/pulse') {
      if (!passesAuth(request, response)) {
        return;
      }
      handlePulse(response);
      return;
    }

    if (request.method === 'POST' && path === '/v1/chat/completions') {
      if (!passesGate(request, response)) {
        return;
      }
      await handleOpenAiCompletions(request, response);
      return;
    }

    const chatMatch = /^\/api\/([a-z]+)\/chat$/.exec(path);
    if (request.method === 'POST' && chatMatch !== null) {
      const target = findPersona(chatMatch[1]);
      if (target === undefined) {
        sendJson(response, 404, { error: 'Нет такой персоны.' });
        return;
      }
      if (!passesGate(request, response)) {
        return;
      }
      await handleChat(request, response, target);
      return;
    }

    sendJson(response, 404, { error: 'Не найдено.' });
  };
}

/** Человекочитаемое описание ошибки для клиента. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Неизвестная ошибка.';
}

/** Код ответа под известные отказы шлюза. */
function statusForError(error: unknown): number {
  if (error instanceof QueueOverflowError) {
    return 429;
  }
  if (error instanceof PromptTooLargeError) {
    return 413;
  }
  return 500;
}
