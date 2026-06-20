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
  ALLOWED_STAGE_TRANSITIONS,
  isAllowedStageTransition,
  stagePrerequisiteMet,
  canTransition,
  applyTransition,
  repairStage,
  InvalidTransitionError,
} from '../index.ts';
import type { TaskRun } from '../index.ts';

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

describe('автомат жизненного цикла', () => {
  /** Прогон на заданном этапе с заданными артефактами. */
  function runAt(stage: TaskRun['stage'], artifacts: TaskRun['artifacts'] = {}): TaskRun {
    return { ...createRun('Задача', { idSuffix: 'sm' }), stage, artifacts };
  }
  const REQ = { collected: [], text: '' };
  const PLAN = { steps: ['s'], criteria: ['c'], text: 'план' };
  const EXEC = { summary: 's', files: [], log: [], text: 't' };

  it('isAllowedStageTransition: по таблице', () => {
    assert.equal(isAllowedStageTransition('requirements', 'planning'), true);
    assert.equal(isAllowedStageTransition('requirements', 'completion'), false); // перепрыгнуть нельзя
    assert.equal(isAllowedStageTransition('verification', 'requirements'), true); // возврат к требованиям
    assert.deepEqual(ALLOWED_STAGE_TRANSITIONS.planning, ['execution']);
  });

  it('stagePrerequisiteMet: артефакт предыдущего этапа обязателен', () => {
    assert.equal(stagePrerequisiteMet(runAt('requirements'), 'requirements'), true); // без предусловий
    assert.equal(stagePrerequisiteMet(runAt('planning'), 'planning'), false); // нет requirements
    assert.equal(stagePrerequisiteMet(runAt('planning', { requirements: REQ }), 'planning'), true);
    assert.equal(stagePrerequisiteMet(runAt('execution'), 'execution'), false); // нет плана
    assert.equal(stagePrerequisiteMet(runAt('execution', { planning: PLAN }), 'execution'), true);
    assert.equal(stagePrerequisiteMet(runAt('verification'), 'verification'), false);
    assert.equal(
      stagePrerequisiteMet(runAt('verification', { execution: EXEC }), 'verification'),
      true,
    );
    // completion — только при пройденной проверке
    assert.equal(stagePrerequisiteMet(runAt('completion'), 'completion'), false);
    assert.equal(
      stagePrerequisiteMet(
        runAt('completion', { verification: { passed: false, issues: [], text: '' } }),
        'completion',
      ),
      false,
    );
    assert.equal(
      stagePrerequisiteMet(
        runAt('completion', { verification: { passed: true, issues: [], text: 'ок' } }),
        'completion',
      ),
      true,
    );
  });

  it('canTransition: тот же этап / разрешён / ребро запрещено / предусловие не выполнено', () => {
    assert.deepEqual(canTransition(runAt('execution'), 'execution'), { ok: true }); // смена статуса
    assert.deepEqual(canTransition(runAt('planning', { requirements: REQ }), 'execution'), {
      ok: false,
      reason: 'не выполнено предусловие этапа «execution»', // план ещё не сделан
    });
    assert.deepEqual(
      canTransition(runAt('planning', { requirements: REQ, planning: PLAN }), 'execution'),
      { ok: true },
    );
    const bad = canTransition(runAt('requirements'), 'completion'); // перепрыгнуть нельзя
    assert.equal(bad.ok, false);
    assert.match((bad as { reason: string }).reason, /не разрешён/);
  });

  it('applyTransition: применяет допустимый и бросает на недопустимом', () => {
    const ok = runAt('planning', { requirements: REQ, planning: PLAN });
    applyTransition(ok, 'execution', 'running');
    assert.equal(ok.stage, 'execution');
    assert.equal(ok.transitions.at(-1)?.stage, 'execution');

    const bad = runAt('requirements');
    assert.throws(
      () => applyTransition(bad, 'completion', 'running'),
      (error: unknown) =>
        error instanceof InvalidTransitionError &&
        error.from === 'requirements' &&
        error.to === 'completion',
    );
    assert.equal(bad.stage, 'requirements'); // состояние не изменилось
  });

  it('repairStage: откатывает несогласованное состояние, валидное не трогает', () => {
    // completion без артефактов → откат к requirements (перепрыгнуть нельзя)
    const broken = runAt('completion');
    assert.equal(repairStage(broken), 'completion'); // вернул прежний этап
    assert.equal(broken.stage, 'requirements');

    // валидная пауза на execution (план есть) → без отката
    const ok = runAt('execution', { requirements: REQ, planning: PLAN });
    assert.equal(repairStage(ok), 'execution');
    assert.equal(ok.stage, 'execution');

    // уже на requirements → не двигаем
    const start = runAt('requirements');
    assert.equal(repairStage(start), 'requirements');
    assert.equal(start.stage, 'requirements');
  });
});
