import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTicketContext,
  pickQuestion,
  pickQuestionAuthor,
  formatQuestionQuote,
} from '../index.ts';
import type { Ticket, TicketComment } from '../../../support-mcp/src/index.ts';

const TICKET: Ticket = {
  id: 42,
  title: 'Не входит',
  body: 'После обновления не пускает',
  author: { login: 'user1' },
  labels: ['auth', 'p1'],
  state: 'open',
  url: 'x',
};

function comment(body: string, isBot: boolean, login = 'user1'): TicketComment {
  return { id: 1, author: { login }, body, createdAt: 't', isBot };
}

describe('formatTicketContext', () => {
  it('метки и диалог (бот/пользователь) в контексте', () => {
    const text = formatTicketContext(TICKET, [
      comment('в чём дело?', false),
      comment('проверьте токен', true, 'bot'),
    ]);
    assert.match(text, /#42/);
    assert.match(text, /Область \(метки\): auth, p1/);
    assert.match(text, /\[user1\] в чём дело\?/);
    assert.match(text, /\[ассистент\] проверьте токен/);
  });

  it('нет меток и нет комментариев → «нет» и без секции диалога', () => {
    const text = formatTicketContext({ ...TICKET, labels: [] }, []);
    assert.match(text, /Область \(метки\): нет/);
    assert.doesNotMatch(text, /Предыдущий диалог/);
  });
});

describe('pickQuestion', () => {
  it('последняя реплика пользователя (не бота)', () => {
    const question = pickQuestion(TICKET, [
      comment('первый вопрос', false),
      comment('ответ бота', true, 'bot'),
      comment('второй вопрос', false),
    ]);
    assert.equal(question, 'второй вопрос');
  });

  it('нет комментариев → описание тикета', () => {
    assert.equal(pickQuestion(TICKET, []), 'После обновления не пускает');
  });

  it('все реплики бота → описание тикета', () => {
    assert.equal(
      pickQuestion(TICKET, [comment('бот', true, 'bot')]),
      'После обновления не пускает',
    );
  });
});

describe('pickQuestionAuthor', () => {
  it('автор последней реплики пользователя', () => {
    const author = pickQuestionAuthor(TICKET, [
      comment('вопрос', false, 'petrov'),
      comment('ответ', true, 'bot'),
      comment('уточнение', false, 'ivanov'),
    ]);
    assert.equal(author, 'ivanov');
  });

  it('нет реплик пользователя → автор тикета', () => {
    assert.equal(pickQuestionAuthor(TICKET, [comment('бот', true, 'bot')]), 'user1');
  });
});

describe('formatQuestionQuote', () => {
  it('блочная цитата с @автором, каждая строка вопроса с >', () => {
    assert.equal(
      formatQuestionQuote('petrov', 'Почему 401?\nТокен верный.'),
      '> **@petrov:**\n> Почему 401?\n> Токен верный.',
    );
  });
});
