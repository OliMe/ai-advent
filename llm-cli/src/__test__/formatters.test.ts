import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTaskList,
  formatCurrentTask,
  formatProfile,
  formatProfileList,
  helpText,
  formatSessionList,
  newSession,
} from '../index.ts';
import { createTask } from '../../../core/src/index.ts';
import { makeConfig } from '../../../core/src/__test__/helpers.ts';
import type { ProfileSummary, TaskSummary } from '../../../core/src/index.ts';

describe('format helpers (задачи и профиль)', () => {
  it('formatTaskList: пусто и со статусами', () => {
    assert.match(formatTaskList([]), /Задач пока нет/);
    const summaries: TaskSummary[] = [
      { id: 'a', title: 'Сайт', status: 'active', createdAt: 't', updatedAt: 't', detailCount: 3 },
      { id: 'b', title: 'Бот', status: 'done', createdAt: 't', updatedAt: 't', detailCount: 0 },
    ];
    const text = formatTaskList(summaries);
    assert.match(text, /• Сайт {2}\(a\) {2}фактов: 3/);
    assert.match(text, /✓ Бот {2}\(b\)/);
  });

  it('formatCurrentTask: нет задачи, с деталями и без', () => {
    assert.match(formatCurrentTask(null), /Активной задачи нет/);
    const task = createTask('Сайт', ['цель: лендинг']);
    assert.match(formatCurrentTask(task), /Текущая задача: Сайт/);
    assert.match(formatCurrentTask(task), /- цель: лендинг/);
    assert.match(formatCurrentTask(createTask('Пусто')), /без деталей/);
  });

  it('formatProfile: пусто и нумерованно, с именем активного', () => {
    assert.match(formatProfile([], 'default'), /Профиль «default»: пуст/);
    assert.match(formatProfile(['любит кратко', 'TypeScript'], 'работа'), /Профиль «работа»:/);
    assert.match(formatProfile(['любит кратко', 'TypeScript'], 'работа'), /1\. любит кратко/);
    assert.match(formatProfile(['любит кратко', 'TypeScript'], 'работа'), /2\. TypeScript/);
  });

  it('formatProfileList: помечает активный и добавляет его, если отсутствует', () => {
    const summaries: ProfileSummary[] = [
      { name: 'работа', entryCount: 3, updatedAt: 't' },
      { name: 'личное', entryCount: 1, updatedAt: 't' },
    ];
    const text = formatProfileList(summaries, 'работа');
    assert.match(text, /\* работа {2}\(пунктов: 3\)/);
    assert.match(text, / {2}личное {2}\(пунктов: 1\)/);
    // Активный, которого нет в списке (ещё пуст), всё равно показан.
    assert.match(formatProfileList([], 'новый'), /\* новый {2}\(пунктов: 0\)/);
  });
});

describe('helpText / formatSessionList / newSession', () => {
  it('helpText содержит ключевые команды', () => {
    const text = helpText();
    assert.match(text, /\/sessions/);
    assert.match(text, /\/branch/);
    assert.match(text, /\/switch/);
    assert.match(text, /\/reset/);
  });

  it('formatSessionList: пусто, с именем ветки и с пустым превью', () => {
    assert.match(formatSessionList([]), /Сохранённых веток нет/);
    assert.match(
      formatSessionList([
        {
          id: 'a',
          model: 'm',
          label: 'main',
          createdAt: 't',
          updatedAt: 't',
          preview: 'вопрос',
          messageCount: 2,
        },
      ]),
      /main {2}\(a\) {2}вопрос/,
    );
    assert.match(
      formatSessionList([
        { id: 'b', model: 'm', createdAt: 't', updatedAt: 't', preview: '', messageCount: 1 },
      ]),
      /— {2}\(b\) {2}\(пусто\)/,
    );
  });

  it('newSession создаёт ветку main с системой из конфига', () => {
    const session = newSession(makeConfig({ model: 'glm', systemPrompt: 'СИС' }), {});
    assert.equal(session.model, 'glm');
    assert.equal(session.label, 'main');
    assert.deepEqual(session.messages, [{ role: 'system', content: 'СИС' }]);
  });
});
