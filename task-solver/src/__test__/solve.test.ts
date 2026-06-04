import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../../../core/src/index.ts';
import {
  parseExperts,
  buildSimpleMessages,
  buildStepByStepMessages,
  buildPromptCraftMessages,
  buildSolveWithPromptMessages,
  buildExpertPanelMessages,
  buildEvaluationMessages,
  solveAll,
  formatResult,
} from '../solve.ts';
import { makeClient } from './helpers.ts';

describe('parseExperts', () => {
  it('делит по запятой, обрезает пробелы и отбрасывает пустые', () => {
    assert.deepEqual(parseExperts('математик, экономист ,, юрист '), [
      'математик',
      'экономист',
      'юрист',
    ]);
  });
});

describe('построение сообщений', () => {
  it('простой запрос — только сообщение пользователя', () => {
    assert.deepEqual(buildSimpleMessages('2+2'), [{ role: 'user', content: '2+2' }]);
  });

  it('пошаговое — системная инструкция + задача', () => {
    const messages = buildStepByStepMessages('2+2');
    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content, /пошагово/);
    assert.equal(messages[1].content, '2+2');
  });

  it('составление промпта — просит не решать задачу', () => {
    const messages = buildPromptCraftMessages('2+2');
    assert.match(messages[0].content, /саму задачу не решай/);
    assert.match(messages[0].content, /2\+2/);
  });

  it('решение по промпту — промпт идёт системным сообщением', () => {
    const messages = buildSolveWithPromptMessages('ВОТ ПРОМПТ', '2+2');
    assert.equal(messages[0].content, 'ВОТ ПРОМПТ');
    assert.equal(messages[1].content, '2+2');
  });

  it('панель экспертов — перечисляет заданных экспертов', () => {
    const messages = buildExpertPanelMessages('2+2', ['математик', 'физик']);
    assert.match(messages[0].content, /математик, физик/);
  });

  it('панель экспертов — фолбэк, если эксперты не заданы', () => {
    const messages = buildExpertPanelMessages('2+2', []);
    assert.match(messages[0].content, /подбери сам/);
  });

  it('оценка — содержит задачу и подписи решений', () => {
    const messages = buildEvaluationMessages('2+2', [
      { label: 'Метод A', text: 'четыре' },
      { label: 'Метод B', text: '4' },
    ]);
    assert.match(messages[1].content, /Метод A/);
    assert.match(messages[1].content, /Метод B/);
    assert.match(messages[1].content, /назови лучшее/i);
  });
});

describe('solveAll', () => {
  it('делает 6 запросов, использует составленный промпт и собирает оценку', async t => {
    let calls = 0;
    const captured: ChatMessage[][] = [];
    const client = makeClient(t, async messages => {
      calls++;
      captured.push(messages);
      return `r${calls}`;
    });

    const result = await solveAll(client, 'задача', ['математик'], 60000);

    assert.equal(calls, 6);
    // r3 — составленный промпт; он должен прийти системным сообщением в запросе 4.
    assert.equal(captured[3][0].content, 'r3');
    assert.deepEqual(
      result.solutions.map(s => s.text),
      ['r1', 'r2', 'r4', 'r5'],
    );
    assert.equal(result.verdict, 'r6');
  });
});

describe('formatResult', () => {
  it('печатает пронумерованные решения и блок оценки', () => {
    const text = formatResult({
      solutions: [
        { label: 'Простой запрос', text: 'A' },
        { label: 'Пошаговое решение', text: 'B' },
      ],
      verdict: 'победил A',
    });
    assert.match(text, /\[1\] Простой запрос\nA/);
    assert.match(text, /\[2\] Пошаговое решение\nB/);
    assert.match(text, /=== Оценка GLM ===\nпобедил A/);
  });
});
