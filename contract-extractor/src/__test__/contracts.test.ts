import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitContracts, batch, DEFAULT_SEPARATOR } from '../contracts.ts';

describe('splitContracts', () => {
  it('делит по маркеру, обрезает пробелы и отбрасывает пустые', () => {
    const text = `\n${DEFAULT_SEPARATOR}\n  Договор A  \n${DEFAULT_SEPARATOR}\nДоговор B\n${DEFAULT_SEPARATOR}\n`;
    assert.deepEqual(splitContracts(text, DEFAULT_SEPARATOR), ['Договор A', 'Договор B']);
  });

  it('поддерживает произвольный разделитель', () => {
    assert.deepEqual(splitContracts('A###B', '###'), ['A', 'B']);
  });
});

describe('batch', () => {
  it('разбивает массив на пакеты нужного размера', () => {
    assert.deepEqual(batch([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });

  it('бросает ошибку при неположительном размере', () => {
    assert.throws(() => batch([1], 0), /положительн/);
  });

  it('бросает ошибку при дробном размере', () => {
    assert.throws(() => batch([1], 2.5), /положительн/);
  });
});
