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
  function harness(reads: (string | null)[]) {
    const input = new EventEmitter();
    let line = '';
    let index = 0;
    const controller = installClipboardPaste(
      input as never,
      { write: data => (line += data) },
      { read: () => reads[index++] ?? null },
    );
    const pasteCtrlV = () => input.emit('keypress', '\x16', { ctrl: true, name: 'v' });
    return { input, controller, pasteCtrlV, line: () => line };
  }

  it('несколько Ctrl+V → плейсхолдеры [Image #N]; consume подставляет пути и сбрасывает счётчик', () => {
    const h = harness(['/tmp/a.png', '/tmp/b.png', '/tmp/c.png']);
    h.pasteCtrlV();
    h.pasteCtrlV();
    assert.equal(h.line(), '[Image #1] [Image #2] ');
    assert.equal(
      h.controller.consume('сравни [Image #1] и [Image #2]'),
      'сравни /tmp/a.png и /tmp/b.png',
    );
    // после consume счётчик сброшен — следующая вставка снова [Image #1]
    h.pasteCtrlV();
    assert.equal(h.line(), '[Image #1] [Image #2] [Image #1] ');
  });

  it('Ctrl+V без картинки → ничего не вставляется; consume без плейсхолдеров не меняет текст', () => {
    const h = harness([null]);
    h.pasteCtrlV();
    assert.equal(h.line(), '');
    assert.equal(h.controller.consume('просто текст'), 'просто текст');
  });

  it('другая клавиша и пустой key игнорируются', () => {
    const h = harness(['/tmp/x.png']);
    h.input.emit('keypress', 'a', { ctrl: false, name: 'a' });
    h.input.emit('keypress', '', undefined);
    assert.equal(h.line(), '');
  });
});
