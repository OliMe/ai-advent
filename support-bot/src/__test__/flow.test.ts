import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runSupportFlow } from '../index.ts';
import type { ChatMessage, ToolSet } from '../../../core/src/index.ts';
import type { SearchChunk } from '../../../grounding/src/index.ts';
import type { TicketComment } from '../../../support-mcp/src/index.ts';

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
  'Ответ: Проверьте заголовок.',
  'Источники:',
  '- authorization.md',
  'Цитаты:',
  '- «Проверьте заголовок Authorization: Bearer <ТОКЕН>.»',
].join('\n');

/** Фейковый ToolSet: тикет + заданные комментарии; фиксирует постинг. */
function fakeToolSet(comments: TicketComment[]): {
  toolSet: ToolSet;
  posted: { id: unknown; body: unknown }[];
} {
  const posted: { id: unknown; body: unknown }[] = [];
  const handlers: Record<string, (args: Record<string, unknown>) => string> = {
    support__get_ticket: () =>
      JSON.stringify({
        id: 42,
        title: 'Не входит',
        body: 'После обновления не пускает',
        author: { login: 'user1' },
        labels: ['auth'],
        state: 'open',
        url: 'https://example/o/r/issues/42',
      }),
    support__get_ticket_comments: () => JSON.stringify(comments),
    support__add_ticket_comment: args => {
      posted.push({ id: args.id, body: args.body });
      return JSON.stringify({
        id: 100,
        author: { login: 'bot' },
        body: args.body,
        createdAt: 't',
        isBot: true,
      });
    },
  };
  const toolSet: ToolSet = {
    specs: () => Object.keys(handlers).map(name => ({ name, description: '', parameters: {} })),
    call: async (name, args) => handlers[name](args),
  };
  return { toolSet, posted };
}

const complete = async (_messages: ChatMessage[]): Promise<string> => GOOD_ANSWER;

describe('runSupportFlow', () => {
  it('открытый тикет (нет комментариев): вопрос = описание, ответ постится', async () => {
    const { toolSet, posted } = fakeToolSet([]);
    let askedQuery = '';
    const result = await runSupportFlow({
      toolSet,
      issueId: 42,
      retrieveFaq: async query => {
        askedQuery = query;
        return FAQ;
      },
      complete,
    });
    assert.equal(result.posted, true);
    assert.equal(result.question, 'После обновления не пускает');
    assert.equal(askedQuery, 'После обновления не пускает');
    const body = posted[0].body as string;
    assert.equal(posted.length, 1);
    // В начале — цитата вопроса с @автором (тикет открыт → автор тикета user1, вопрос = описание).
    assert.match(body, /^> \*\*@user1:\*\*\n> После обновления не пускает\n\n/);
    // Ярлык «Ответ:» снят из тела ответа.
    assert.doesNotMatch(body, /Ответ:/);
    assert.match(body, /Проверьте заголовок\./);
    assert.match(body, /Источники:/);
  });

  it('follow-up: вопрос = последняя реплика пользователя', async () => {
    const { toolSet } = fakeToolSet([
      { id: 1, author: { login: 'u' }, body: 'первый', createdAt: 't', isBot: false },
      { id: 2, author: { login: 'bot' }, body: 'ответ бота', createdAt: 't', isBot: true },
      { id: 3, author: { login: 'u' }, body: 'уточняющий вопрос', createdAt: 't', isBot: false },
    ]);
    const result = await runSupportFlow({
      toolSet,
      issueId: 42,
      retrieveFaq: async () => FAQ,
      complete,
      onCitationFailure: () => {},
    });
    assert.equal(result.question, 'уточняющий вопрос');
    assert.equal(result.posted, true);
  });

  it('с linkRef+repoRoot: «Источники» постятся кликабельной ссылкой на файл+раздел', async () => {
    const { toolSet, posted } = fakeToolSet([]);
    const result = await runSupportFlow({
      toolSet,
      issueId: 42,
      retrieveFaq: async () => [
        {
          chunk_id: 'authorization.md#0',
          source: '/repo/support-bot/faq',
          file: 'authorization.md',
          section: 'Авторизация',
          score: 0.9,
          text: 'Проверьте заголовок Authorization: Bearer <ТОКЕН>.',
        },
      ],
      complete: async () =>
        [
          'Ответ: Проверьте заголовок.',
          'Источники:',
          '- authorization.md › Авторизация',
          'Цитаты:',
          '- «Проверьте заголовок Authorization: Bearer <ТОКЕН>.»',
        ].join('\n'),
      linkRef: 'SHA1',
      repoRoot: '/repo',
    });
    assert.equal(result.posted, true);
    const body = posted[0].body as string;
    assert.match(
      body,
      /- \[authorization\.md\]\(https:\/\/example\/o\/r\/blob\/SHA1\/support-bot\/faq\/authorization\.md\) › \[Авторизация\]\(https:\/\/example\/o\/r\/blob\/SHA1\/support-bot\/faq\/authorization\.md#авторизация\)/,
    );
  });

  it('защита петли: последний комментарий бота → не отвечаем', async () => {
    const { toolSet, posted } = fakeToolSet([
      { id: 1, author: { login: 'u' }, body: 'вопрос', createdAt: 't', isBot: false },
      { id: 2, author: { login: 'bot' }, body: 'ответ бота', createdAt: 't', isBot: true },
    ]);
    const result = await runSupportFlow({
      toolSet,
      issueId: 42,
      retrieveFaq: async () => FAQ,
      complete,
    });
    assert.equal(result.posted, false);
    assert.match(result.reason ?? '', /петл/);
    assert.deepEqual(posted, []);
  });
});
