import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { requiredBearerToken, authorize } from '../index.ts';

const env = (values: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  values as NodeJS.ProcessEnv;

describe('requiredBearerToken', () => {
  it('возвращает токен или undefined (пусто/пробелы → undefined)', () => {
    assert.equal(requiredBearerToken(env({ MCP_BEARER_TOKEN: 'tkn' })), 'tkn');
    assert.equal(requiredBearerToken(env({ MCP_BEARER_TOKEN: '   ' })), undefined);
    assert.equal(requiredBearerToken(env({})), undefined);
  });
});

describe('authorize', () => {
  it('без токена доступ открыт', () => {
    assert.equal(authorize(undefined, undefined), true);
    assert.equal(authorize('что угодно', undefined), true);
  });

  it('с токеном требует точного Bearer', () => {
    assert.equal(authorize('Bearer tkn', 'tkn'), true);
    assert.equal(authorize('Bearer другой', 'tkn'), false);
    assert.equal(authorize('tkn', 'tkn'), false); // без префикса Bearer
    assert.equal(authorize(undefined, 'tkn'), false); // нет заголовка
  });
});
