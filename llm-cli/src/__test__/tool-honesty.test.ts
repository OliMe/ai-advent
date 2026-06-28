import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claimsSchedulerActionWithoutCall, TOOL_HONESTY_DIRECTIVE } from '../index.ts';

describe('claimsSchedulerActionWithoutCall', () => {
  it('заявлено действие (глагол+существительное), инструмент не вызван → true', () => {
    assert.equal(claimsSchedulerActionWithoutCall('Создал два напоминания: …', []), true);
    assert.equal(claimsSchedulerActionWithoutCall('Удалил задачу про отчёт', []), true);
  });

  it('изменяющий инструмент действительно вызван → false', () => {
    assert.equal(
      claimsSchedulerActionWithoutCall('Создал напоминание', ['scheduler__schedule_task']),
      false,
    );
  });

  it('вызван читающий инструмент (list_tasks) → false, даже если в данных есть глагол «удаление»', () => {
    const answer =
      'Вот задачи: «Уточнить про поезд на удаление сервиса gifts». Всего 7 активных задач.';
    assert.equal(claimsSchedulerActionWithoutCall(answer, ['scheduler__list_tasks']), false);
  });

  it('нет глагола действия → false', () => {
    assert.equal(claimsSchedulerActionWithoutCall('Распознано: AI ADVENT 2026', []), false);
  });

  it('предложение-инфинитив (не заявление) → false', () => {
    // «могу добавить/поставить» — это предложение, а не заявление о выполненном.
    assert.equal(
      claimsSchedulerActionWithoutCall(
        'Могу добавить любую в список дел или поставить напоминание.',
        [],
      ),
      false,
    );
  });

  it('нет существительного планировщика → false', () => {
    assert.equal(claimsSchedulerActionWithoutCall('Создал отчёт по погоде', []), false);
  });

  it('директива упоминает обязательный вызов инструмента', () => {
    assert.match(TOOL_HONESTY_DIRECTIVE, /ОБЯЗАН вызвать/);
  });
});
