import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CompositeToolSet } from '../index.ts';
import type { ToolSet, ToolSpec } from '../index.ts';

/** Фейковый набор с заданными инструментами; call возвращает «<имя>:<набор>». */
function fakeSet(label: string, names: string[]): ToolSet {
  const specs: ToolSpec[] = names.map(name => ({ name, description: '', parameters: {} }));
  return {
    specs: () => specs,
    call: async name => `${name}:${label}`,
  };
}

describe('CompositeToolSet', () => {
  it('specs — конкатенация наборов', () => {
    const composite = new CompositeToolSet([fakeSet('a', ['x', 'y']), fakeSet('b', ['z'])]);
    assert.deepEqual(
      composite.specs().map(spec => spec.name),
      ['x', 'y', 'z'],
    );
  });

  it('call направляется набору, у которого есть инструмент', async () => {
    const composite = new CompositeToolSet([fakeSet('a', ['x']), fakeSet('b', ['z'])]);
    assert.equal(await composite.call('x', {}), 'x:a');
    assert.equal(await composite.call('z', {}), 'z:b');
  });

  it('неизвестный инструмент → бросает', async () => {
    const composite = new CompositeToolSet([fakeSet('a', ['x'])]);
    await assert.rejects(() => composite.call('нет', {}), /Инструмент не найден/);
  });
});
