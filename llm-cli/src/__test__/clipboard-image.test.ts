import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import {
  defaultClipboardTempPath,
  realCommandRunner,
  readClipboardImage,
  macClipboardImageReader,
  installClipboardPaste,
  type CommandRunner,
} from '../index.ts';

describe('clipboard-image — путь временного файла', () => {
  it('лежит во временном каталоге, уникален между вызовами', () => {
    const first = defaultClipboardTempPath();
    const second = defaultClipboardTempPath();
    assert.ok(first.startsWith(tmpdir()));
    assert.match(first, /\.png$/);
    assert.notEqual(first, second);
  });
});

describe('clipboard-image — запуск команды', () => {
  it('реальный раннер возвращает stdout', () => {
    const out = realCommandRunner('node', ['-e', 'process.stdout.write("привет")']);
    assert.equal(out, 'привет');
  });
});

describe('clipboard-image — чтение буфера', () => {
  const fixedPath = '/tmp/clip-fixed.png';
  const makePath = () => fixedPath;

  it('ok → возвращает путь', () => {
    const runner: CommandRunner = () => 'ok\n';
    assert.equal(readClipboardImage(runner, makePath), fixedPath);
  });
  it('none → null', () => {
    const runner: CommandRunner = () => 'none\n';
    assert.equal(readClipboardImage(runner, makePath), null);
  });
  it('ошибка команды → null', () => {
    const runner: CommandRunner = () => {
      throw new Error('нет osascript');
    };
    assert.equal(readClipboardImage(runner, makePath), null);
  });
  it('реальный читатель выполняется и даёт null или путь', () => {
    const result = macClipboardImageReader.read();
    assert.ok(result === null || typeof result === 'string');
  });
});

describe('clipboard-image — перехват Ctrl+V', () => {
  function harness(clipboardResult: string | null) {
    const input = new EventEmitter();
    let line = '';
    let out = '';
    installClipboardPaste(
      input as never,
      { write: data => (line += data) },
      { write: data => (out += data) },
      { read: () => clipboardResult },
    );
    return { input, line: () => line, out: () => out };
  }

  it('Ctrl+V с картинкой → путь в строку и пометка', () => {
    const h = harness('/tmp/x.png');
    h.input.emit('keypress', '\x16', { ctrl: true, name: 'v' });
    assert.equal(h.line(), '/tmp/x.png ');
    assert.match(h.out(), /📎 путь к изображению из буфера вставлен: \/tmp\/x\.png/);
  });

  it('Ctrl+V без картинки → пометка, строка не меняется', () => {
    const h = harness(null);
    h.input.emit('keypress', '\x16', { ctrl: true, name: 'v' });
    assert.equal(h.line(), '');
    assert.match(h.out(), /в буфере обмена нет изображения/);
  });

  it('другая клавиша и пустой key игнорируются', () => {
    const h = harness('/tmp/x.png');
    h.input.emit('keypress', 'a', { ctrl: false, name: 'a' });
    h.input.emit('keypress', '', undefined);
    assert.equal(h.line(), '');
    assert.equal(h.out(), '');
  });
});
