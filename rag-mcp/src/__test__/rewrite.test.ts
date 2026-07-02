import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeRewriter } from '../index.ts';
import type { ChatComplete } from '../index.ts';

/** Фейковый complete, возвращающий заданный текст и запоминающий промпты. */
const fake = (reply: string): { complete: ChatComplete; systems: string[]; users: string[] } => {
  const systems: string[] = [];
  const users: string[] = [];
  const complete: ChatComplete = async (system, user) => {
    systems.push(system);
    users.push(user);
    return reply;
  };
  return { complete, systems, users };
};

describe('makeRewriter', () => {
  it('mode=none → null (модель не вызывается)', () => {
    const { complete } = fake('x');
    assert.equal(makeRewriter('none', complete), null);
  });

  it('expand дописывает обогащение к запросу', async () => {
    const { complete, users } = fake('организации, места, рядом');
    const rewrite = makeRewriter('expand', complete);
    assert.ok(rewrite);
    assert.equal(await rewrite('где поесть'), 'где поесть\nорганизации, места, рядом');
    assert.deepEqual(users, ['где поесть']); // исходный запрос ушёл модели
  });

  it('expand с пустым ответом → исходный запрос', async () => {
    const { complete } = fake('   ');
    const rewrite = makeRewriter('expand', complete);
    assert.ok(rewrite);
    assert.equal(await rewrite('вопрос'), 'вопрос');
  });

  it('hyde заменяет запрос гипотетическим документом', async () => {
    const { complete } = fake('Чтобы найти места рядом, используйте координаты.');
    const rewrite = makeRewriter('hyde', complete);
    assert.ok(rewrite);
    assert.equal(
      await rewrite('как найти места'),
      'Чтобы найти места рядом, используйте координаты.',
    );
  });

  it('hyde с пустым ответом → исходный запрос', async () => {
    const { complete } = fake('');
    const rewrite = makeRewriter('hyde', complete);
    assert.ok(rewrite);
    assert.equal(await rewrite('вопрос'), 'вопрос');
  });
});
