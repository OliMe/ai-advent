import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
  it('собирает все 4 решения и оценку, используя составленный промпт', async t => {
    // Параллельные запросы приходят в произвольном порядке — отвечаем по содержимому.
    const CRAFTED = 'СОСТАВЛЕННЫЙ-ПРОМПТ';
    let calls = 0;
    const client = makeClient(t, async messages => {
      calls++;
      const system = messages[0]?.role === 'system' ? messages[0].content : '';
      const user = messages.find(m => m.role === 'user')?.content ?? '';
      if (system.includes('судья')) return 'ВЕРДИКТ';
      if (system === CRAFTED) return 'двухшаговое';
      if (system.includes('пошагово')) return 'пошаговое';
      if (system.includes('эксперт')) return 'панель';
      if (user.includes('Составь')) return CRAFTED;
      return 'простое';
    });

    const result = await solveAll(client, 'задача', ['математик'], 60000);

    assert.equal(calls, 6);
    assert.deepEqual(
      result.solutions.map(s => s.text),
      ['простое', 'пошаговое', 'двухшаговое', 'панель'],
    );
    // «двухшаговое» вернулось только потому, что запрос пришёл с системным
    // промптом CRAFTED — значит составленный промпт реально использован.
    assert.equal(result.verdict, 'ВЕРДИКТ');
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
