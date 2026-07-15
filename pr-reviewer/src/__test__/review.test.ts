import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateReview, fileFromPatch, REVIEW_SCHEMA } from '../index.ts';
import type { ReviewDeps, ReviewInput } from '../index.ts';
import { clientWith } from '../../../core/src/__test__/helpers.ts';
import type { CompleteOptions, ChatMessage } from '../../../core/src/index.ts';

const INPUT: ReviewInput = {
  title: 'Добавить проверку токена',
  description: 'Проверяем bearer в authorize',
  files: [fileFromPatch('src/auth.ts', '@@ -1,1 +1,2 @@\n ctx\n+const t = req.token;', 'modified')],
  docFragments: ['README.md\nАвторизация по bearer-токену.'],
  fileContents: [{ path: 'src/auth.ts', content: 'export function authorize() {}' }],
};

const REVIEW_JSON = JSON.stringify({
  findings: [
    {
      file: 'src/auth.ts',
      line: 2,
      severity: 'bug',
      title: 'нет проверки',
      body: 'токен не валидируется',
    },
  ],
  summary: 'Один потенциальный баг.',
});

describe('generateReview', () => {
  it('собирает промпт со схемой и разбирает находки', async t => {
    let seen: { messages: ChatMessage[]; options: CompleteOptions } | undefined;
    const client = clientWith(t, (messages, options) => {
      seen = { messages, options };
      return { content: REVIEW_JSON };
    });
    const deps: ReviewDeps = {
      client,
      disableThinking: true,
      requestTimeoutMs: 1000,
      temperature: 0.2,
      maxTokens: 2048,
      contextTokens: 8192,
    };

    const result = await generateReview(deps, INPUT);

    // Промпт содержит роль, эхо схемы и секции ввода (diff, доки, содержимое файлов).
    const system = seen?.messages[0].content ?? '';
    const user = seen?.messages[1].content ?? '';
    assert.match(system, /строгий ревьюер/);
    assert.match(system, /"severity"/); // эхо схемы
    assert.match(user, /Изменения на ревью/);
    assert.match(user, /Документация проекта/);
    assert.match(user, /Содержимое изменённых файлов/);
    // disableThinking прокинут; тумблер выключен → без response_format (безопасно для GLM).
    assert.equal(seen?.options.disableThinking, true);
    assert.equal(seen?.options.responseFormat, undefined);

    assert.deepEqual(result.findings, [
      {
        file: 'src/auth.ts',
        line: 2,
        severity: 'bug',
        title: 'нет проверки',
        body: 'токен не валидируется',
      },
    ]);
    assert.equal(result.summary, 'Один потенциальный баг.');
  });

  it('при structuredOutputs=true кладёт схему ревью в response_format', async t => {
    let seen: CompleteOptions | undefined;
    const client = clientWith(t, (_messages, options) => {
      seen = options;
      return { content: REVIEW_JSON };
    });
    await generateReview(
      {
        client,
        structuredOutputs: true,
        disableThinking: false,
        requestTimeoutMs: 1000,
        temperature: 0.2,
        maxTokens: 2048,
        contextTokens: 8192,
      },
      INPUT,
    );
    assert.deepEqual(seen?.responseFormat, { type: 'json_schema', json_schema: REVIEW_SCHEMA });
  });

  it('пустое описание и без доков/файлов — секции опускаются, diff остаётся', async t => {
    let user = '';
    const client = clientWith(t, messages => {
      user = messages[1].content;
      return { content: '{"findings":[],"summary":"нет замечаний"}' };
    });
    const result = await generateReview(
      {
        client,
        disableThinking: false,
        requestTimeoutMs: 1000,
        temperature: 0.2,
        maxTokens: 2048,
        contextTokens: 8192,
      },
      {
        title: 'PR',
        description: '   ',
        files: [fileFromPatch('a.ts', '@@ -1 +1 @@\n+x', 'added')],
        docFragments: [],
        fileContents: [],
      },
    );
    assert.doesNotMatch(user, /Описание/);
    assert.doesNotMatch(user, /Документация проекта/);
    assert.doesNotMatch(user, /Содержимое изменённых файлов/);
    assert.match(user, /Изменения на ревью/);
    assert.deepEqual(result.findings, []);
  });
});
