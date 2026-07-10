import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ChatMessage,
  CompleteOptions,
  CompletionResult,
  StreamDelta,
} from '../../../core/src/index.ts';
import {
  buildFoodGuardMessages,
  formatFoodRefusal,
  makeFoodAssessor,
  parseFoodVerdict,
  type GuardChatClient,
} from '../food-guard.ts';

test('buildFoodGuardMessages: система, few-shot примеры, затем запрос пользователя', () => {
  const messages = buildFoodGuardMessages('яйца, лук');
  assert.equal(messages[0].role, 'system');
  assert.equal(messages.at(-1)?.content, 'яйца, лук');
  // Хотя бы одна пара примеров есть между системой и запросом.
  assert.ok(messages.length > 3);
  assert.ok(messages.some(message => message.role === 'assistant'));
});

test('parseFoodVerdict: вердикт ЕДА без причины', () => {
  const verdict = parseFoodVerdict('ЕДА');
  assert.equal(verdict.edible, true);
  assert.equal(verdict.reason, '');
});

test('parseFoodVerdict: вердикт ЕДА с причиной на второй строке', () => {
  const verdict = parseFoodVerdict('ЕДА\nВсе позиции съедобны.');
  assert.equal(verdict.edible, true);
  assert.equal(verdict.reason, 'Все позиции съедобны.');
});

test('parseFoodVerdict: НЕ_ЕДА распознаётся и не путается с ЕДА', () => {
  const verdict = parseFoodVerdict('НЕ_ЕДА\nГвозди несъедобны.');
  assert.equal(verdict.edible, false);
  assert.equal(verdict.reason, 'Гвозди несъедобны.');
});

test('parseFoodVerdict: слитное НЕЕДА тоже считается отказом', () => {
  assert.equal(parseFoodVerdict('НЕЕДА').edible, false);
});

test('parseFoodVerdict: пустой ответ — fail-closed (отказ)', () => {
  const verdict = parseFoodVerdict('   \n  ');
  assert.equal(verdict.edible, false);
  assert.equal(verdict.reason, '');
});

test('parseFoodVerdict: нераспознанный вердикт — тоже отказ', () => {
  assert.equal(parseFoodVerdict('затрудняюсь ответить').edible, false);
});

test('formatFoodRefusal: с причиной модели', () => {
  const text = formatFoodRefusal('Гвозди несъедобны.');
  assert.match(text, /только из съедобных/);
  assert.match(text, /Гвозди несъедобны\./);
});

test('formatFoodRefusal: без причины — только рамка отказа', () => {
  const text = formatFoodRefusal('');
  assert.match(text, /только из съедобных/);
  assert.doesNotMatch(text, /\n\n\n/);
});

/** Клиент-заглушка, отдающий заданный ответ classifier'а. */
function fakeGuardClient(content: string, deltas: StreamDelta[] = []): GuardChatClient {
  return {
    async streamWithUsage(
      _messages: ChatMessage[],
      _options: CompleteOptions,
      onDelta: (delta: StreamDelta) => void,
    ): Promise<CompletionResult> {
      deltas.forEach(onDelta);
      return { content };
    },
  };
}

test('makeFoodAssessor: разбирает вердикт из result.content', async () => {
  const assess = makeFoodAssessor(() => fakeGuardClient('НЕ_ЕДА\nмолоток несъедобен'));
  const verdict = await assess('qwen2.5:3b', 'молоток, гвозди');
  assert.equal(verdict.edible, false);
  assert.equal(verdict.reason, 'молоток несъедобен');
});

test('makeFoodAssessor: если content пуст, собирает вердикт из стрима', async () => {
  const assess = makeFoodAssessor(() =>
    fakeGuardClient('', [{ content: 'ЕДА' }, { reasoning: 'мысли' }]),
  );
  const verdict = await assess('qwen2.5:3b', 'яйца, лук');
  assert.equal(verdict.edible, true);
});
