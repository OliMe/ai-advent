import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveMood, type MoodInputs } from '../mood.ts';

/** Спокойный узел: свободная память, пустая очередь, простаивающий процессор. */
const CALM_INPUTS: MoodInputs = {
  cpuIdlePercent: 95,
  loadAverage1m: 0.1,
  memoryAvailableRatio: 0.6,
  queueDepth: 1,
};

test('нехватка памяти важнее всего остального', () => {
  const mood = resolveMood({ ...CALM_INPUTS, memoryAvailableRatio: 0.1, queueDepth: 3 });
  assert.equal(mood.key, 'hungry');
  assert.equal(mood.maxTokens, 160);
});

test('очередь делает узел раздражённым', () => {
  const mood = resolveMood({ ...CALM_INPUTS, queueDepth: 2 });
  assert.equal(mood.key, 'grumpy');
  assert.match(mood.toneInstruction, /ворчлив/);
});

test('высокая средняя загрузка раздражает даже без очереди', () => {
  const mood = resolveMood({ ...CALM_INPUTS, loadAverage1m: 3.5 });
  assert.equal(mood.key, 'grumpy');
});

test('занятый процессор при пустой очереди — деловой тон', () => {
  const mood = resolveMood({ ...CALM_INPUTS, cpuIdlePercent: 20 });
  assert.equal(mood.key, 'busy');
  assert.equal(mood.temperature, 0.5);
});

test('простаивающий узел благодушен и словоохотлив', () => {
  const mood = resolveMood(CALM_INPUTS);
  assert.equal(mood.key, 'calm');
  assert.equal(mood.maxTokens, 520);
  assert.equal(mood.emoji, '😌');
});
