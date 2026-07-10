import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PERSONA, PERSONAS, findPersona } from '../personas.ts';

test('персона одна, и она же по умолчанию', () => {
  assert.equal(PERSONAS.length, 1);
  assert.equal(DEFAULT_PERSONA.slug, 'kitchen');
});

test('модель выбрана по замеру генеративного русского', () => {
  assert.equal(DEFAULT_PERSONA.model, 'qwen2.5:3b');
});

test('профиль генерации задан персоной, а не вызовом', () => {
  assert.equal(DEFAULT_PERSONA.temperature, 0.7);
  assert.equal(DEFAULT_PERSONA.maxTokens, 500);
});

test('findPersona: известный сегмент пути', () => {
  assert.equal(findPersona('kitchen')?.title, 'Что приготовить?');
});

test('findPersona: неизвестный сегмент', () => {
  assert.equal(findPersona('нет-такой'), undefined);
});
