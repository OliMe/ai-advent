import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStrategy, trimHistoryToBudget } from '../index.ts';
import { clientWith } from './helpers.ts';
import { ChatCompletionClient } from '../../../core/src/index.ts';
import { makeConfig } from '../../../core/src/__test__/helpers.ts';
import type { ChatMessage, Usage } from '../../../core/src/index.ts';

describe('стратегии памяти (createMemoryStrategy)', () => {
  const sys: ChatMessage = { role: 'system', content: 'СИС' };
  const big = (role: ChatMessage['role'], n: number): ChatMessage => ({
    role,
    content: `${role}-${n} ${'x'.repeat(60)}`,
  });

  it('window: passthrough = trimHistoryToBudget', async () => {
    const strategy = createMemoryStrategy(
      'window',
      10_000,
      6,
      new ChatCompletionClient(makeConfig()),
      5000,
    );
    const messages = [sys, big('user', 1), big('assistant', 1)];
    assert.deepEqual(await strategy.prepare(messages), trimHistoryToBudget(messages, 10_000));
    strategy.reset(); // no-op, не падает
  });

  it('summary: реплик не больше N — без сжатия, резюме не добавляется', async t => {
    const client = clientWith(t, async () => ({ content: 'не-нужно', usage: undefined }));
    const strategy = createMemoryStrategy('summary', 1000, 2, client, 5000); // N=2
    const result = await strategy.prepare([sys, big('user', 1), big('assistant', 1)]);

    assert.deepEqual(
      result.map(m => m.role),
      ['system', 'user', 'assistant'],
    );
    assert.ok(!result.some(m => m.content.includes('Краткое содержание')));
  });

  it('summary: только система', async t => {
    const client = clientWith(t, async () => ({ content: 'x', usage: undefined }));
    const strategy = createMemoryStrategy('summary', 1000, 2, client, 5000);
    assert.deepEqual(await strategy.prepare([sys]), [sys]);
  });

  it('summary: сворачивает всё, кроме последних N; второй прогон — с непустым резюме', async t => {
    let folds = 0;
    const client = clientWith(t, async () => {
      folds++;
      return {
        content: 'РЕЗ',
        usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      };
    });
    const strategy = createMemoryStrategy('summary', 1000, 2, client, 5000); // N=2
    const compressions: (Usage | undefined)[] = [];
    const m1 = [
      sys,
      big('user', 1),
      big('assistant', 1),
      big('user', 2),
      big('assistant', 2),
      big('user', 3),
    ];

    const r1 = await strategy.prepare(m1, u => compressions.push(u));
    assert.equal(r1[0], sys);
    assert.equal(r1[1].role, 'system'); // резюме как system-сообщение
    assert.match(r1[1].content, /Краткое содержание/);
    assert.equal(r1.length, 4); // система + резюме + последние 2 реплики
    assert.ok(r1[2].content.startsWith('assistant-2'));
    assert.ok(r1[3].content.startsWith('user-3')); // дословно — последние 2

    const m2 = [...m1, big('assistant', 3), big('user', 4)];
    const r2 = await strategy.prepare(m2, u => compressions.push(u));
    assert.match(r2[1].content, /Краткое содержание/);
    assert.ok(r2.some(m => m.content.startsWith('user-4')));
    assert.equal(folds, 2); // два прогона сжатия (пустое и непустое резюме)
    assert.equal(compressions.length, 2);
  });

  it('summary: без onCompression тоже сворачивает', async t => {
    const client = clientWith(t, async () => ({ content: 'РЕЗ', usage: undefined }));
    const strategy = createMemoryStrategy('summary', 1000, 1, client, 5000); // N=1
    const messages = [sys, big('user', 1), big('assistant', 1), big('user', 2)];
    const result = await strategy.prepare(messages); // onCompression не передан
    assert.match(result[1].content, /Краткое содержание/);
  });

  it('summary: при сбое сжатия откатывается к окну', async t => {
    const client = clientWith(t, async () => {
      throw new Error('сжатие упало');
    });
    const strategy = createMemoryStrategy('summary', 1000, 1, client, 5000);
    const messages = [sys, big('user', 1), big('assistant', 1), big('user', 2)];
    assert.deepEqual(await strategy.prepare(messages), trimHistoryToBudget(messages, 1000));
  });

  it('summary: reset() очищает резюме', async t => {
    const client = clientWith(t, async () => ({ content: 'РЕЗ', usage: undefined }));
    const strategy = createMemoryStrategy('summary', 1000, 1, client, 5000);
    const messages = [sys, big('user', 1), big('assistant', 1), big('user', 2)];
    await strategy.prepare(messages); // создаём резюме
    strategy.reset();
    const after = await strategy.prepare([sys, big('user', 1)]); // ≤ N → без резюме
    assert.ok(!after.some(m => m.content.includes('Краткое содержание')));
  });

  it('facts: добавляет блок фактов и держит последние N дословно', async t => {
    let updates = 0;
    const client = clientWith(t, async () => {
      updates++;
      return {
        content: 'Цель: сайт',
        usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      };
    });
    const strategy = createMemoryStrategy('facts', 1000, 2, client, 5000); // N=2
    const updateUsage: (Usage | undefined)[] = [];
    const messages = [
      sys,
      big('user', 1),
      big('assistant', 1),
      big('user', 2),
      big('assistant', 2),
      big('user', 3),
    ];

    const result = await strategy.prepare(messages, u => updateUsage.push(u));
    assert.equal(result[0], sys);
    assert.equal(result[1].role, 'system'); // блок фактов как system-сообщение
    assert.match(result[1].content, /Известные факты/);
    assert.match(result[1].content, /Цель: сайт/);
    assert.equal(result.length, 4); // система + факты + последние 2 реплики
    assert.ok(result[2].content.startsWith('assistant-2'));
    assert.ok(result[3].content.startsWith('user-3'));
    assert.equal(updates, 1);
    assert.equal(updateUsage.length, 1);
  });

  it('facts: на втором ходу учитывает только новые реплики', async t => {
    const seen: string[] = [];
    const client = clientWith(t, async messages => {
      seen.push(messages[0].content);
      return { content: 'Цель: сайт', usage: undefined };
    });
    const strategy = createMemoryStrategy('facts', 1000, 2, client, 5000);
    const m1 = [sys, big('user', 1)];
    await strategy.prepare(m1);
    const m2 = [...m1, big('assistant', 1), big('user', 2)];
    await strategy.prepare(m2);
    // Второй промпт обновления содержит только новое (ответ 1 + вопрос 2), не вопрос 1.
    assert.ok(seen[1].includes('assistant-1'));
    assert.ok(seen[1].includes('user-2'));
    assert.ok(!seen[1].includes('user-1 '));
  });

  it('facts: при сбое обновления оставляет прежние факты', async t => {
    let calls = 0;
    const client = clientWith(t, async () => {
      calls++;
      if (calls === 2) throw new Error('обновление упало');
      return { content: 'Цель: сайт', usage: undefined };
    });
    const strategy = createMemoryStrategy('facts', 1000, 1, client, 5000);
    await strategy.prepare([sys, big('user', 1)]); // факты созданы
    const after = await strategy.prepare([
      sys,
      big('user', 1),
      big('assistant', 1),
      big('user', 2),
    ]);
    // Несмотря на сбой второго обновления, прежний блок фактов сохранён.
    assert.match(after[1].content, /Цель: сайт/);
  });

  it('facts: только система — без вызова модели и без блока фактов', async t => {
    const client = clientWith(t, async () => ({ content: 'x', usage: undefined }));
    const strategy = createMemoryStrategy('facts', 1000, 2, client, 5000);
    const result = await strategy.prepare([sys]);
    assert.deepEqual(result, [sys]);
  });

  it('facts: подстраховка окном, если факты + N не влезают в бюджет', async t => {
    const client = clientWith(t, async () => ({ content: 'x'.repeat(900), usage: undefined }));
    const strategy = createMemoryStrategy('facts', 100, 5, client, 5000); // крошечный бюджет
    const messages = [sys, big('user', 1), big('assistant', 1), big('user', 2)];
    const result = await strategy.prepare(messages);
    // Блок фактов сам по себе больше бюджета → окно оставляет системные сообщения
    // и лишь самую свежую реплику (старые user-1/assistant-1 обрезаются).
    assert.deepEqual(
      result.map(m => m.role),
      ['system', 'system', 'user'],
    );
    assert.match(result[1].content, /Известные факты/);
    assert.ok(result[2].content.startsWith('user-2'));
  });

  it('facts: reset() очищает блок фактов', async t => {
    const client = clientWith(t, async () => ({ content: 'Цель: сайт', usage: undefined }));
    const strategy = createMemoryStrategy('facts', 1000, 1, client, 5000);
    await strategy.prepare([sys, big('user', 1)]); // создаём факты
    strategy.reset();
    // clientWith вернёт те же факты, но проверяем, что factedThrough сброшен:
    const after = await strategy.prepare([sys]); // нет реплик → без вызова, без блока
    assert.deepEqual(after, [sys]);
  });
});
