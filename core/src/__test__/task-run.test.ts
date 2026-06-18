import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRun,
  nextStage,
  summarizeRun,
  STAGES,
  RUN_VERSION,
  DEFAULT_MAX_RETRIES,
} from '../index.ts';

const FIXED = new Date('2026-06-10T14:25:30.000Z');

describe('createRun', () => {
  it('создаёт прогон на planning с дефолтами и сортируемым id', () => {
    const run = createRun('Сделать сайт', { now: FIXED, idSuffix: 'aaa111' });
    assert.equal(run.version, RUN_VERSION);
    assert.equal(run.id, '20260610T142530-aaa111');
    assert.equal(run.title, 'Сделать сайт');
    assert.equal(run.stage, 'planning');
    assert.equal(run.status, 'running');
    assert.deepEqual(run.artifacts, {});
    assert.equal(run.retries, 0);
    assert.equal(run.maxRetries, DEFAULT_MAX_RETRIES);
    assert.deepEqual(run.transitions, [
      { stage: 'planning', status: 'running', at: '2026-06-10T14:25:30.000Z' },
    ]);
    assert.ok(!('taskId' in run)); // без taskId поля нет
  });

  it('принимает taskId и maxRetries; id по умолчанию случайный', () => {
    const run = createRun('T', { taskId: 'task-1', maxRetries: 5 });
    assert.equal(run.taskId, 'task-1');
    assert.equal(run.maxRetries, 5);
    assert.match(run.id, /^\d{8}T\d{6}-[0-9a-f]{6}$/);
  });
});

describe('nextStage', () => {
  it('идёт по порядку и упирается в null на последнем', () => {
    assert.equal(nextStage('planning'), 'execution');
    assert.equal(nextStage('execution'), 'verification');
    assert.equal(nextStage('verification'), 'completion');
    assert.equal(nextStage('completion'), null);
  });

  it('порядок этапов фиксирован', () => {
    assert.deepEqual(STAGES, ['planning', 'execution', 'verification', 'completion']);
  });
});

describe('summarizeRun', () => {
  it('собирает сводку прогона', () => {
    const run = createRun('Задача', { now: FIXED, idSuffix: 'sss' });
    assert.deepEqual(summarizeRun(run), {
      id: run.id,
      title: 'Задача',
      stage: 'planning',
      status: 'running',
      updatedAt: run.updatedAt,
    });
  });
});
