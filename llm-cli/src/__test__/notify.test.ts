import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { systemNotify, realNotifyRunner } from '../index.ts';

describe('systemNotify', () => {
  it('зовёт osascript с заголовком и текстом', () => {
    let captured: { command: string; args: string[] } | null = null;
    systemNotify('Заголовок', 'Сообщение', (command, args) => {
      captured = { command, args };
    });
    assert.equal(captured!.command, 'osascript');
    const script = captured!.args.join(' ');
    assert.match(script, /display notification "Сообщение" with title "Заголовок"/);
  });

  it('ошибка раннера проглатывается (best-effort)', () => {
    assert.doesNotThrow(() =>
      systemNotify('т', 'м', () => {
        throw new Error('нет osascript');
      }),
    );
  });
});

describe('realNotifyRunner', () => {
  it('выполняет команду без ошибки', () => {
    assert.doesNotThrow(() => realNotifyRunner('node', ['-e', '']));
  });
});
