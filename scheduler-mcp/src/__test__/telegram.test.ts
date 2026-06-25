import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTelegramConfig, sendTelegramMessage } from '../index.ts';
import type { TelegramFetch } from '../index.ts';

const env = (values: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  values as NodeJS.ProcessEnv;

describe('loadTelegramConfig', () => {
  it('оба значения заданы → конфиг', () => {
    assert.deepEqual(loadTelegramConfig(env({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '42' })), {
      botToken: 't',
      chatId: '42',
    });
  });

  it('что-то не задано → undefined', () => {
    assert.equal(loadTelegramConfig(env({ TELEGRAM_BOT_TOKEN: 't' })), undefined);
    assert.equal(loadTelegramConfig(env({ TELEGRAM_CHAT_ID: '42' })), undefined);
    assert.equal(loadTelegramConfig(env({})), undefined);
  });
});

describe('sendTelegramMessage', () => {
  const config = { botToken: 'tok', chatId: '42' };

  it('ok → доставлено, корректный URL и тело', async () => {
    let captured: { url: string; body: string } | null = null;
    const fetchFn: TelegramFetch = async (url, init) => {
      captured = { url, body: init.body };
      return { ok: true, status: 200 };
    };
    const result = await sendTelegramMessage(config, 'привет', fetchFn);
    assert.deepEqual(result, { delivered: true });
    assert.match(captured!.url, /api\.telegram\.org\/bottok\/sendMessage/);
    assert.match(captured!.body, /"chat_id":"42"/);
  });

  it('не-ok → не доставлено с кодом', async () => {
    const fetchFn: TelegramFetch = async () => ({ ok: false, status: 403 });
    assert.deepEqual(await sendTelegramMessage(config, 'x', fetchFn), {
      delivered: false,
      error: 'HTTP 403',
    });
  });

  it('исключение → не доставлено с текстом ошибки', async () => {
    const fetchFn: TelegramFetch = async () => {
      throw new Error('нет сети');
    };
    assert.deepEqual(await sendTelegramMessage(config, 'x', fetchFn), {
      delivered: false,
      error: 'нет сети',
    });
  });

  it('исключение не-Error → приводится к строке', async () => {
    const fetchFn: TelegramFetch = async () => {
      throw 'строковый сбой';
    };
    assert.deepEqual(await sendTelegramMessage(config, 'x', fetchFn), {
      delivered: false,
      error: 'строковый сбой',
    });
  });
});
