import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRun,
  nextStage,
  summarizeRun,
  STAGES,
  RUN_VERSION,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_REQUIREMENT_CYCLES,
} from '../index.ts';

const FIXED = new Date('2026-06-10T14:25:30.000Z');

describe('createRun', () => {
  it('создаёт прогон на requirements с дефолтами и сортируемым id', () => {
    const run = createRun('Сделать сайт', { now: FIXED, idSuffix: 'aaa111' });
    assert.equal(run.version, RUN_VERSION);
    assert.equal(run.id, '20260610T142530-aaa111');
    assert.equal(run.title, 'Сделать сайт');
    assert.equal(run.stage, 'requirements');
    assert.equal(run.status, 'running');
    assert.deepEqual(run.artifacts, {});
    assert.equal(run.retries, 0);
    assert.equal(run.maxRetries, DEFAULT_MAX_RETRIES);
    assert.equal(run.requirementCycles, 0);
    assert.equal(run.maxRequirementCycles, DEFAULT_MAX_REQUIREMENT_CYCLES);
    assert.deepEqual(run.transitions, [
      { stage: 'requirements', status: 'running', at: '2026-06-10T14:25:30.000Z' },
    ]);
    assert.ok(!('taskId' in run)); // без taskId поля нет
  });

  it('принимает taskId, maxRetries и maxRequirementCycles; id по умолчанию случайный', () => {
    const run = createRun('T', { taskId: 'task-1', maxRetries: 5, maxRequirementCycles: 2 });
    assert.equal(run.taskId, 'task-1');
    assert.equal(run.maxRetries, 5);
    assert.equal(run.maxRequirementCycles, 2);
    assert.match(run.id, /^\d{8}T\d{6}-[0-9a-f]{6}$/);
  });
});

describe('nextStage', () => {
  it('идёт по порядку и упирается в null на последнем', () => {
    assert.equal(nextStage('requirements'), 'planning');
    assert.equal(nextStage('planning'), 'execution');
    assert.equal(nextStage('execution'), 'verification');
    assert.equal(nextStage('verification'), 'completion');
    assert.equal(nextStage('completion'), null);
  });

  it('порядок этапов фиксирован', () => {
    assert.deepEqual(STAGES, [
      'requirements',
      'planning',
      'execution',
      'verification',
      'completion',
    ]);
  });
});

describe('summarizeRun', () => {
  it('собирает сводку прогона', () => {
    const run = createRun('Задача', { now: FIXED, idSuffix: 'sss' });
    assert.deepEqual(summarizeRun(run), {
      id: run.id,
      title: 'Задача',
      stage: 'requirements',
      status: 'running',
      updatedAt: run.updatedAt,
    });
  });
});
