import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileInvariantsStore, InvariantsMemory, INVARIANTS_VERSION } from '../index.ts';

describe('FileInvariantsStore', () => {
  it('пустой при отсутствии файла; сохраняет и читает обратно', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'));
    try {
      const store = new FileInvariantsStore(join(dir, 'invariants.json'));
      assert.deepEqual(store.load(), []); // файла ещё нет
      store.save(['только нативный TS', 'без сторонних библиотек']);
      assert.deepEqual(store.load(), ['только нативный TS', 'без сторонних библиотек']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('битый JSON и не-файл-инвариантов → пустой список', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'));
    try {
      const path = join(dir, 'invariants.json');
      writeFileSync(path, 'не json');
      assert.deepEqual(new FileInvariantsStore(path).load(), []);
      writeFileSync(path, JSON.stringify({ version: INVARIANTS_VERSION, invariants: [1, 2] }));
      assert.deepEqual(new FileInvariantsStore(path).load(), []); // элементы не строки
      writeFileSync(path, JSON.stringify({ x: 1 }));
      assert.deepEqual(new FileInvariantsStore(path).load(), []); // нет поля invariants
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('InvariantsMemory', () => {
  it('add (дедуп/пусто), remove (по номерам), block, all', () => {
    const memory = new InvariantsMemory(null); // режим в памяти
    assert.deepEqual(memory.all(), []);
    assert.equal(memory.block(100), null); // пусто → нет блока

    assert.equal(memory.add('  только нативный TS  '), 'только нативный TS'); // обрезка
    assert.equal(memory.add('только нативный TS'), null); // дубль
    assert.equal(memory.add('   '), null); // пусто
    assert.equal(memory.add('без сборки'), 'без сборки');
    assert.equal(memory.add('бизнес-правило'), 'бизнес-правило');
    assert.deepEqual(memory.all(), ['только нативный TS', 'без сборки', 'бизнес-правило']);

    const block = memory.block(1000);
    assert.match(block?.content ?? '', /ИНВАРИАНТЫ \(нарушать нельзя\):/);
    assert.match(block?.content ?? '', /- только нативный TS/);

    assert.deepEqual(memory.remove([9]), []); // вне диапазона
    // Несколько номеров вне порядка — резолвятся до удаления и сортируются.
    assert.deepEqual(memory.remove([3, 1]), ['только нативный TS', 'бизнес-правило']);
    assert.deepEqual(memory.all(), ['без сборки']);
  });

  it('add персистится в хранилище', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inv-'));
    try {
      const store = new FileInvariantsStore(join(dir, 'invariants.json'));
      const memory = new InvariantsMemory(store);
      memory.add('бизнес-правило X');
      assert.deepEqual(store.load(), ['бизнес-правило X']); // сохранилось на диск
      // Новый слой над тем же хранилищем видит сохранённое.
      assert.deepEqual(new InvariantsMemory(store).all(), ['бизнес-правило X']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
