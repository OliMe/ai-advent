import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorize, extractBearerToken, rateLimitIdentity } from '../auth.ts';

test('extractBearerToken: заголовка нет', () => {
  assert.equal(extractBearerToken(undefined), undefined);
});

test('extractBearerToken: чужая схема авторизации', () => {
  assert.equal(extractBearerToken('Basic YWRtaW4='), undefined);
});

test('extractBearerToken: пустой токен после префикса', () => {
  assert.equal(extractBearerToken('Bearer    '), undefined);
});

test('extractBearerToken: токен извлекается', () => {
  assert.equal(extractBearerToken('Bearer секрет'), 'секрет');
});

test('authorize: пустой список токенов — доступ открыт', () => {
  assert.equal(authorize(undefined, []), true);
});

test('authorize: токен требуется, но не предъявлен', () => {
  assert.equal(authorize(undefined, ['секрет']), false);
});

test('authorize: предъявлен неверный токен', () => {
  assert.equal(authorize('Bearer чужой', ['секрет']), false);
});

test('authorize: предъявлен верный токен', () => {
  assert.equal(authorize('Bearer секрет', ['другой', 'секрет']), true);
});

test('rateLimitIdentity: с токеном считаем по токену', () => {
  assert.equal(rateLimitIdentity('Bearer секрет', '10.0.0.1'), 'token:секрет');
});

test('rateLimitIdentity: без токена считаем по адресу', () => {
  assert.equal(rateLimitIdentity(undefined, '10.0.0.1'), 'ip:10.0.0.1');
});
