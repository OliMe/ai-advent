import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ElicitationBridge, readlineConfirm } from '../index.ts';
import { isAffirmative } from '../index.ts';

describe('ElicitationBridge', () => {
  it('без setConfirm → decline (безопасный отказ)', async () => {
    const bridge = new ElicitationBridge();
    assert.deepEqual(await bridge.handler({ message: 'вне песочницы?' }), { action: 'decline' });
  });

  it('confirm=true → accept', async () => {
    const bridge = new ElicitationBridge();
    bridge.setConfirm(async () => true);
    assert.deepEqual(await bridge.handler({ message: 'разрешить?' }), { action: 'accept' });
  });

  it('confirm=false → decline', async () => {
    const bridge = new ElicitationBridge();
    bridge.setConfirm(async () => false);
    assert.deepEqual(await bridge.handler({ message: 'разрешить?' }), { action: 'decline' });
  });
});

describe('readlineConfirm', () => {
  it('«да» → true, печатает предупреждение с сообщением', async () => {
    let asked = '';
    const confirm = readlineConfirm(async prompt => {
      asked = prompt;
      return 'Да';
    }, isAffirmative);
    assert.equal(await confirm('операция вне песочницы'), true);
    assert.match(asked, /⚠ операция вне песочницы \(да\/нет\)/);
  });

  it('«нет» → false', async () => {
    const confirm = readlineConfirm(async () => 'нет', isAffirmative);
    assert.equal(await confirm('что-то'), false);
  });
});
