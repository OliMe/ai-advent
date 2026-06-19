import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTaskList,
  formatCurrentTask,
  formatProfile,
  formatProfileList,
  helpText,
  formatSessionList,
  formatStageResult,
  formatRunStatus,
  formatRunList,
  formatRunContext,
  stageLabel,
  statusLabel,
  newSession,
} from '../index.ts';
import { createTask, createRun } from '../../../core/src/index.ts';
import { makeConfig } from '../../../core/src/__test__/helpers.ts';
import type { ProfileSummary, RunSummary, TaskRun, TaskSummary } from '../../../core/src/index.ts';

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

describe('форматирование прогонов задач', () => {
  it('stageLabel / statusLabel по-русски', () => {
    assert.equal(stageLabel('planning'), 'планирование');
    assert.equal(statusLabel('paused'), 'на паузе');
  });

  it('formatStageResult: полный читаемый результат по этапам и ветвям', () => {
    // requirements: список собранных пунктов; пусто — «уточнения не потребовались».
    assert.match(
      formatStageResult('requirements', {
        requirements: { collected: ['Бюджет → 100к'], text: 'Бюджет → 100к' },
      }),
      /Собранные требования:\n {2}- Бюджет → 100к/,
    );
    assert.equal(
      formatStageResult('requirements', { requirements: { collected: [], text: '' } }),
      'Уточнения не потребовались.',
    );

    // planning: шаги (нумерованно) + критерии; фолбэк на text, если оба пусты.
    const plan = formatStageResult('planning', {
      planning: { steps: ['собрать', 'проверить'], criteria: ['тесты зелёные'], text: 'прозаично' },
    });
    assert.match(plan, /Шаги:\n {2}1\. собрать\n {2}2\. проверить/);
    assert.match(plan, /Критерии приёмки:\n {2}- тесты зелёные/);
    assert.equal(
      formatStageResult('planning', {
        planning: { steps: [], criteria: [], text: 'весь план тут' },
      }),
      'весь план тут',
    );

    // execution: summary-заголовок + полный text + ссылки на файлы (и без них).
    assert.equal(
      formatStageResult('execution', {
        execution: { summary: 'готово', files: ['/p/1.md'], log: [], text: 'КОД' },
      }),
      'готово\n\nКОД\n\nФайлы: /p/1.md',
    );
    assert.equal(
      formatStageResult('execution', {
        execution: { summary: '', files: [], log: [], text: 'просто результат' },
      }),
      'просто результат',
    );

    // verification: вердикт + замечания + текст.
    assert.match(
      formatStageResult('verification', {
        verification: { passed: true, issues: [], text: 'всё ок' },
      }),
      /Проверка пройдена ✓\nвсё ок/,
    );
    const failed = formatStageResult('verification', {
      verification: { passed: false, issues: ['нет тестов'], text: 'детали' },
    });
    assert.match(failed, /Проверка НЕ пройдена ✗/);
    assert.match(failed, /Замечания:\n {2}- нет тестов/);
    assert.match(failed, /детали/);

    // completion: читаемый итог (text).
    assert.equal(
      formatStageResult('completion', {
        completion: { summary: 'кратко', text: 'итоговое резюме' },
      }),
      'итоговое резюме',
    );
  });

  it('formatRunStatus: пустой прогон и полный с правкой', () => {
    const fresh = createRun('Задача', { idSuffix: 'f' });
    const freshText = formatRunStatus(fresh);
    assert.match(freshText, /Задача: Задача/);
    assert.match(freshText, /Этап: сбор требований · статус: идёт · возвраты: 0\/10/);
    assert.doesNotMatch(freshText, /Планирование:/);

    const full: TaskRun = {
      ...createRun('Полная', { idSuffix: 'g' }),
      stage: 'completion',
      correction: 'учесть тёмную тему',
      artifacts: {
        requirements: { collected: ['Бюджет → 100к', 'Сроки → месяц'], text: '' },
        planning: { steps: ['ш1'], criteria: ['к1'], text: 'п' },
        execution: { summary: 'сделано', files: ['/p/1.md'], log: [], text: 'r' },
        verification: { passed: true, issues: [], text: 'ок' },
        completion: { summary: 'готово', text: 'резюме' },
      },
    };
    const fullText = formatRunStatus(full);
    assert.match(fullText, /Требования: 2 пункт\(ов\)/);
    assert.match(fullText, /Правка к учёту: учесть тёмную тему/);
    assert.match(fullText, /Планирование: 1 шаг\(ов\), 1 критери/);
    assert.match(fullText, /Выполнение: сделано \(\/p\/1\.md\)/);
    assert.match(fullText, /Проверка: пройдена/);
    assert.match(fullText, /Завершение: готово/);

    // ветви: execution без файлов и непройденная проверка
    const partial: TaskRun = {
      ...createRun('Частичная', { idSuffix: 'h' }),
      artifacts: {
        execution: { summary: 'черновик', files: [], log: [], text: '' },
        verification: { passed: false, issues: ['x'], text: '' },
      },
    };
    const partialText = formatRunStatus(partial);
    assert.match(partialText, /Выполнение: черновик\n/);
    assert.match(partialText, /Проверка: есть замечания/);
  });

  it('formatRunContext: детали и/или профиль, иначе пусто', () => {
    assert.equal(formatRunContext([], []), '');
    assert.match(formatRunContext(['бюджет 100к'], []), /Контекст задачи:\n- бюджет 100к/);
    assert.match(formatRunContext([], ['любит кратко']), /О пользователе:\n- любит кратко/);
    const both = formatRunContext(['цель X'], ['пишет на TS']);
    assert.match(both, /Контекст задачи:\n- цель X/);
    assert.match(both, /О пользователе:\n- пишет на TS/);
  });

  it('formatRunContext: при превышении бюджета держит свежие детали, ранние помечает', () => {
    // Крошечный бюджет → влезает только самая свежая деталь, ранние опущены.
    const capped = formatRunContext(['старое требование', 'свежее требование'], [], 3);
    assert.match(capped, /- … \(ранние детали опущены\)/);
    assert.match(capped, /- свежее требование/);
    assert.doesNotMatch(capped, /старое требование/);
  });

  it('formatRunList: пусто и со сводками', () => {
    assert.match(formatRunList([]), /Прогонов задач пока нет/);
    const summaries: RunSummary[] = [
      { id: 'r1', title: 'Первая', stage: 'execution', status: 'paused', updatedAt: '' },
    ];
    const text = formatRunList(summaries);
    assert.match(text, /Прогоны задач:/);
    assert.match(text, /Первая  \(r1\)  выполнение · на паузе/);
  });
});
