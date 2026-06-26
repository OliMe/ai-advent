import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { driveInteractive, taskRunClient } from './helpers.ts';
import { makeConfig } from '../../../core/src/__test__/helpers.ts';
import type { VoiceInput } from '../index.ts';

/** Фейковый голосовой ввод с настраиваемыми finish/transcribe. */
function fakeVoice(
  options: {
    finish?: () => Promise<Uint8Array>;
    transcribe?: (audio: Uint8Array) => Promise<string>;
  } = {},
): VoiceInput {
  return {
    recorder: { start: () => ({ finish: options.finish ?? (async () => new Uint8Array([1, 2])) }) },
    transcribe: options.transcribe ?? (async () => 'купить молоко'),
  };
}

/** Запускает интерактив с голосовым вводом и заданными строками. */
function drive(lines: string[], voice: VoiceInput | null, t: Parameters<typeof taskRunClient>[0]) {
  return driveInteractive(
    taskRunClient(t),
    lines,
    0.7,
    makeConfig(),
    true,
    null,
    undefined,
    'window',
    6,
    undefined,
    null,
    null,
    voice,
  );
}

describe('интерактив — /voice', () => {
  it('записывает, распознаёт и вставляет текст в строку ввода', async t => {
    const { finished, text } = drive(['/voice', '', '', '/exit'], fakeVoice(), t);
    await finished;
    const out = text();
    assert.match(out, /Говорите… \(Enter — стоп\)/);
    assert.match(out, /📝 Распознано: купить молоко/);
    assert.match(out, /купить молоко/); // текст вставлен в строку (эхо readline)
  });

  it('голос не настроен → подсказка про переменные окружения', async t => {
    const { finished, text } = drive(['/voice', '/exit'], null, t);
    await finished;
    assert.match(text(), /Голосовой ввод не настроен/);
    assert.match(text(), /YANDEX_API_KEY/);
  });

  it('сбой записи → сообщение об ошибке, сессия живёт', async t => {
    const voice = fakeVoice({
      finish: async () => {
        throw new Error('микрофон занят');
      },
    });
    const { finished, text } = drive(['/voice', '', '/exit'], voice, t);
    await finished;
    assert.match(text(), /Не удалось записать звук: микрофон занят/);
  });

  it('сбой распознавания → сообщение об ошибке', async t => {
    const voice = fakeVoice({
      transcribe: async () => {
        throw new Error('STT недоступен');
      },
    });
    const { finished, text } = drive(['/voice', '', '/exit'], voice, t);
    await finished;
    assert.match(text(), /Не удалось распознать речь: STT недоступен/);
  });
});
