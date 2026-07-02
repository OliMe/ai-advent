import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withPrefix } from '../index.ts';

describe('withPrefix', () => {
  it('добавляет префикс к каждому входу перед эмбеддингом', async () => {
    const seen: string[] = [];
    const embed = async (inputs: string[]): Promise<number[][]> => {
      seen.push(...inputs);
      return inputs.map(() => [1, 0]);
    };
    const prefixed = withPrefix(embed, 'search_document: ');
    const vectors = await prefixed(['первый', 'второй']);
    assert.deepEqual(seen, ['search_document: первый', 'search_document: второй']);
    assert.equal(vectors.length, 2);
  });

  it('пустой префикс не меняет входы', async () => {
    const seen: string[] = [];
    const embed = async (inputs: string[]): Promise<number[][]> => {
      seen.push(...inputs);
      return inputs.map(() => [0, 1]);
    };
    await withPrefix(embed, '')(['текст']);
    assert.deepEqual(seen, ['текст']);
  });
});
