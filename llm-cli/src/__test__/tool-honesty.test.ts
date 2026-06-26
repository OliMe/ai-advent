import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claimsSchedulerActionWithoutCall, TOOL_HONESTY_DIRECTIVE } from '../index.ts';

describe('claimsSchedulerActionWithoutCall', () => {
  it('заявлено действие (глагол+существительное), инструмент не вызван → true', () => {
    assert.equal(claimsSchedulerActionWithoutCall('Создал два напоминания: …', []), true);
    assert.equal(claimsSchedulerActionWithoutCall('Удалил задачу про отчёт', []), true);
  });

  it('инструмент действительно вызван → false', () => {
    assert.equal(
      claimsSchedulerActionWithoutCall('Создал напоминание', ['scheduler__schedule_task']),
      false,
    );
  });

  it('нет глагола действия → false', () => {
    assert.equal(claimsSchedulerActionWithoutCall('Распознано: AI ADVENT 2026', []), false);
  });

  it('нет существительного планировщика → false', () => {
    assert.equal(claimsSchedulerActionWithoutCall('Создал отчёт по погоде', []), false);
  });

  it('директива упоминает обязательный вызов инструмента', () => {
    assert.match(TOOL_HONESTY_DIRECTIVE, /ОБЯЗАН вызвать/);
  });
});
