import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PERSONAS, composeSystemPrompt, findPersona } from '../personas.ts';

test('обе персоны объявлены и живут на разных моделях', () => {
  assert.equal(PERSONAS.length, 2);
  const models = PERSONAS.map(persona => persona.model);
  assert.deepEqual(new Set(models).size, 2);
});

test('findPersona: известный сегмент пути', () => {
  const persona = findPersona('kitchen');
  assert.equal(persona?.model, 'qwen2.5:3b');
});

test('findPersona: неизвестный сегмент', () => {
  assert.equal(findPersona('нет-такой'), undefined);
});

test('composeSystemPrompt: тон настроения дописывается к промпту персоны', () => {
  const persona = findPersona('grumpy');
  assert.ok(persona);
  const prompt = composeSystemPrompt(persona, 'Отвечай ворчливо.');
  assert.ok(prompt.startsWith(persona.systemPrompt));
  assert.ok(prompt.endsWith('Отвечай ворчливо.'));
});
