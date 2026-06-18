import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { describeError, reportFatalError } from '../index.ts';

describe('describeError', () => {
  it('распознаёт таймаут по имени TimeoutError', () => {
    const error = new Error('timed out');
    error.name = 'TimeoutError';
    assert.equal(describeError(error), 'превышено время ожидания ответа от API.');
  });

  it('возвращает message для обычной ошибки', () => {
    assert.equal(describeError(new Error('что-то пошло не так')), 'что-то пошло не так');
  });

  it('приводит не-Error к строке', () => {
    assert.equal(describeError('просто строка'), 'просто строка');
  });
});

describe('reportFatalError', () => {
  it('печатает ошибку и выставляет код выхода 1', t => {
    const messages: string[] = [];
    t.mock.method(console, 'error', (message: string) => {
      messages.push(message);
    });
    const savedExitCode = process.exitCode;
    try {
      reportFatalError(new Error('фатальная ошибка'));
      assert.match(messages[0], /Ошибка: фатальная ошибка/);
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});
