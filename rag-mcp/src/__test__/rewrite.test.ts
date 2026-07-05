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
  it('expand дописывает обогащение к запросу', async () => {
    const { complete, users } = fake('организации, места, рядом');
    const rewrite = makeRewriter('expand', complete);
    assert.equal(await rewrite('где поесть'), 'где поесть\nорганизации, места, рядом');
    assert.deepEqual(users, ['где поесть']); // исходный запрос ушёл модели
  });

  it('expand с пустым ответом → исходный запрос', async () => {
    const { complete } = fake('   ');
    const rewrite = makeRewriter('expand', complete);
    assert.equal(await rewrite('вопрос'), 'вопрос');
  });

  it('hyde заменяет запрос гипотетическим документом', async () => {
    const { complete } = fake('Чтобы найти места рядом, используйте координаты.');
    const rewrite = makeRewriter('hyde', complete);
    assert.equal(
      await rewrite('как найти места'),
      'Чтобы найти места рядом, используйте координаты.',
    );
  });

  it('hyde с пустым ответом → исходный запрос', async () => {
    const { complete } = fake('');
    const rewrite = makeRewriter('hyde', complete);
    assert.equal(await rewrite('вопрос'), 'вопрос');
  });

  it('hyde с языком корпуса → промпт велит перевести и писать на этом языке', async () => {
    const { complete, systems } = fake('The deep profile is used for on-demand incident response.');
    const rewrite = makeRewriter('hyde', complete, 'English');
    const out = await rewrite('какой профиль для инцидент-реагирования?');
    assert.equal(out, 'The deep profile is used for on-demand incident response.'); // гипотетич. документ на EN
    assert.match(systems[0], /«English»/);
    assert.match(systems[0], /перевед/i); // указание перевести смысл запроса
    assert.doesNotMatch(systems[0], /как в запросе/); // не прежний фолбэк
  });

  it('expand с языком корпуса → синонимы на языке документации', async () => {
    const { complete, systems } = fake('incident response, on-demand scan, deep profile');
    const rewrite = makeRewriter('expand', complete, 'English');
    assert.equal(
      await rewrite('инцидент-реагирование'),
      'инцидент-реагирование\nincident response, on-demand scan, deep profile',
    );
    assert.match(systems[0], /НА ЯЗЫКЕ «English»/);
  });

  it('пустой/пробельный язык → фолбэк «как в запросе»', async () => {
    const { complete, systems } = fake('фрагмент');
    await makeRewriter('hyde', complete, '   ')('вопрос');
    assert.match(systems[0], /как в запросе/); // пробельный язык трактуется как «не задан»
  });
});
