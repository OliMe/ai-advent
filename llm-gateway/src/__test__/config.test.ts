import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  loadGatewayConfig,
  readBasePath,
  readBearerTokens,
  readPositiveInteger,
} from '../config.ts';

test('readBasePath: не задан — сервис живёт в корне', () => {
  assert.equal(readBasePath(undefined), '');
});

test('readBasePath: пробелы и один слэш — тоже корень', () => {
  assert.equal(readBasePath('  '), '');
  assert.equal(readBasePath('/'), '');
});

test('readBasePath: ведущий слэш добавляется, хвостовой убирается', () => {
  assert.equal(readBasePath('ai/'), '/ai');
  assert.equal(readBasePath('/ai'), '/ai');
});

test('readPositiveInteger: не задано — берётся значение по умолчанию', () => {
  assert.equal(readPositiveInteger(undefined, 7), 7);
});

test('readPositiveInteger: не число — значение по умолчанию', () => {
  assert.equal(readPositiveInteger('не число', 7), 7);
});

test('readPositiveInteger: ноль и отрицательное — значение по умолчанию', () => {
  assert.equal(readPositiveInteger('0', 7), 7);
  assert.equal(readPositiveInteger('-3', 7), 7);
});

test('readPositiveInteger: корректное число разбирается', () => {
  assert.equal(readPositiveInteger(' 42 ', 7), 42);
});

test('readBearerTokens: не задано — пустой список (авторизация выключена)', () => {
  assert.deepEqual(readBearerTokens(undefined), []);
});

test('readBearerTokens: пустые элементы отбрасываются', () => {
  assert.deepEqual(readBearerTokens(' первый , , второй ,'), ['первый', 'второй']);
});

test('loadGatewayConfig: пустое окружение — значения по умолчанию', () => {
  const config = loadGatewayConfig({});
  assert.equal(config.port, 3002);
  assert.deepEqual(config.bearerTokens, []);
  assert.equal(config.rateLimitCapacity, 10);
  assert.equal(config.rateLimitRefillPerMinute, 10);
  assert.equal(config.maxPromptTokens, 1500);
  assert.equal(config.maxQueueDepth, 4);
  assert.equal(config.quotaCores, 3);
  assert.equal(config.upstreamBaseUrl, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(config.requestTimeoutMs, 300_000);
  assert.equal(config.basePath, '');
});

test('loadGatewayConfig: пустая строка апстрима — тоже значение по умолчанию', () => {
  const config = loadGatewayConfig({ GATEWAY_UPSTREAM_URL: '   ' });
  assert.equal(config.upstreamBaseUrl, 'http://127.0.0.1:11434/v1/chat/completions');
});

test('loadGatewayConfig: переменные окружения перекрывают умолчания', () => {
  const config = loadGatewayConfig({
    GATEWAY_PORT: '8080',
    GATEWAY_TOKENS: 'секрет',
    GATEWAY_RATE_CAPACITY: '3',
    GATEWAY_RATE_REFILL_PER_MINUTE: '2',
    GATEWAY_MAX_PROMPT_TOKENS: '500',
    GATEWAY_MAX_QUEUE: '2',
    GATEWAY_QUOTA_CORES: '4',
    GATEWAY_UPSTREAM_URL: 'http://example.test/v1/chat/completions',
    GATEWAY_TIMEOUT_MS: '1000',
    GATEWAY_BASE_PATH: '/ai',
  });
  assert.equal(config.basePath, '/ai');
  assert.equal(config.port, 8080);
  assert.deepEqual(config.bearerTokens, ['секрет']);
  assert.equal(config.rateLimitCapacity, 3);
  assert.equal(config.rateLimitRefillPerMinute, 2);
  assert.equal(config.maxPromptTokens, 500);
  assert.equal(config.maxQueueDepth, 2);
  assert.equal(config.quotaCores, 4);
  assert.equal(config.upstreamBaseUrl, 'http://example.test/v1/chat/completions');
  assert.equal(config.requestTimeoutMs, 1000);
});
