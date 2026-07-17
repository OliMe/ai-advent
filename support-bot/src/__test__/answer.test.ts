import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { answerSupportQuestion, stripAnswerLabel } from '../index.ts';
import type { SearchChunk } from '../../../grounding/src/index.ts';

describe('stripAnswerLabel', () => {
  it('снимает ведущий «Ответ:» (в т.ч. с переносом и markdown-заголовком)', () => {
    assert.equal(stripAnswerLabel('Ответ: текст ответа'), 'текст ответа');
    assert.equal(stripAnswerLabel('Ответ:\nтекст'), 'текст');
    assert.equal(stripAnswerLabel('## Ответ: текст'), 'текст');
    assert.equal(stripAnswerLabel('**Ответ:** текст'), 'текст');
  });

  it('не трогает многострочность после первой строки', () => {
    assert.equal(stripAnswerLabel('Ответ: строка1\nстрока2'), 'строка1\nстрока2');
  });

  it('без ярлыка (фолбэк «Не знаю…») — без изменений', () => {
    assert.equal(stripAnswerLabel('Не знаю: контекста нет.'), 'Не знаю: контекста нет.');
  });
});

const FAQ: SearchChunk[] = [
  {
    chunk_id: 'authorization.md#0',
    source: '/faq',
    file: 'authorization.md',
    section: 'Авторизация',
    score: 0.9,
    text: 'Проверьте заголовок Authorization: Bearer <ТОКЕН>.',
  },
];

const GOOD_ANSWER = [
  'Ответ: Проверьте заголовок авторизации.',
  'Источники:',
  '- authorization.md',
  'Цитаты:',
  '- «Проверьте заголовок Authorization: Bearer <ТОКЕН>.»',
].join('\n');

describe('answerSupportQuestion', () => {
  it('корректный ответ с источником+цитатой из FAQ → проходит гейт', async () => {
    const result = await answerSupportQuestion(
      { complete: async () => GOOD_ANSWER, faqChunks: FAQ, ticketContext: 'контекст тикета' },
      'почему не работает авторизация?',
    );
    assert.equal(result, GOOD_ANSWER);
  });

  it('нет фрагментов FAQ → честное «не знаю»', async () => {
    const result = await answerSupportQuestion(
      { complete: async () => GOOD_ANSWER, faqChunks: [], ticketContext: 'ctx' },
      'вопрос вне FAQ',
    );
    assert.match(result, /Не знаю/);
  });

  it('плохой первый ответ → перегенерация до корректного, колбэк провала вызван', async () => {
    let calls = 0;
    const failures: number[] = [];
    const result = await answerSupportQuestion(
      {
        complete: async () => {
          calls += 1;
          return calls === 1 ? 'ответ без секций' : GOOD_ANSWER;
        },
        faqChunks: FAQ,
        ticketContext: 'ctx',
        onCitationFailure: (_reason, attempt) => failures.push(attempt),
      },
      'вопрос',
    );
    assert.equal(result, GOOD_ANSWER);
    assert.equal(calls, 2);
    assert.deepEqual(failures, [1]);
  });

  it('пустые фрагменты (пробельный текст) → блок цитат-кандидатов пропущен, безопасный фолбэк', async () => {
    const result = await answerSupportQuestion(
      {
        complete: async () => 'что угодно без формата',
        faqChunks: [{ ...FAQ[0], text: '   ', section: '' }],
        ticketContext: 'ctx',
      },
      'вопрос',
    );
    assert.match(result, /Не могу подтвердить/);
  });
});
