import * as readline from 'node:readline/promises';
import { PassThrough, Writable } from 'node:stream';
import { runInteractive, type MemoryKind, type MemorySettings } from '../index.ts';
import { ChatCompletionClient, createSession, summarize } from '../../../core/src/index.ts';
import type { AppConfig, Session, SessionStore } from '../../../core/src/index.ts';
import { makeConfig } from '../../../core/src/__test__/helpers.ts';

// Моки клиента живут в core (движок памяти там же); реэкспортируем для CLI-тестов.
export { clientWith, clientWithStream } from '../../../core/src/__test__/helpers.ts';

/** Сессия с системным сообщением из конфига (для интерактивных тестов). */
export function makeSession(config: AppConfig = makeConfig()): Session {
  return createSession(config.model, [{ role: 'system', content: config.systemPrompt }]);
}

/** Сохранённая сессия с заданным id (для /switch и /branch). */
export function storedSession(id: string): Session {
  return {
    version: 1,
    id,
    model: 'm',
    createdAt: '2026-06-10T10:00:00.000Z',
    updatedAt: '2026-06-10T10:00:00.000Z',
    messages: [
      { role: 'system', content: 'СИС' },
      { role: 'user', content: 'прошлый вопрос' },
    ],
  };
}

/** Хранилище-заглушка для сессий: записывает сохранения, позволяет задать содержимое. */
export function fakeStore(sessions: Session[] = []): SessionStore & { saved: Session[] } {
  const map = new Map(sessions.map(session => [session.id, session]));
  const saved: Session[] = [];
  return {
    saved,
    list: () => sessions.map(summarize),
    load: id => map.get(id) ?? null,
    save: session => {
      saved.push(session);
      map.set(session.id, session);
    },
    latest: () => sessions[sessions.length - 1] ?? null,
  };
}

/** Поток-приёмник: накапливает записанный текст. */
export function makeCollector(): { stream: Writable; text: () => string } {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => buffer };
}

/** Небольшая пауза, чтобы дать промисам/слушателям прокрутиться. */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Прогоняет интерактивный режим, подавая очередную строку в ответ на приглашение
 * «Вы: ». Это детерминированно: readline получает ровно одну строку на вопрос
 * (если писать пачкой, лишние события 'line' теряются между вопросами).
 */
export function driveInteractive(
  client: ChatCompletionClient,
  lines: string[],
  temperature = 0.7,
  config: AppConfig = makeConfig(),
  stream = true,
  store: SessionStore | null = null,
  session: Session = makeSession(config),
  memory: MemoryKind = 'window',
  keepRecent = 6,
  memorySettings?: MemorySettings,
): { finished: Promise<void>; text: () => string } {
  const input = new PassThrough();
  let buffer = '';
  let next = 0;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      buffer += text;
      // Подаём следующую строку на приглашение «Вы: » и на запрос подтверждения «(да/нет)».
      if ((text.includes('Вы: ') || text.includes('(да/нет)')) && next < lines.length) {
        const line = lines[next++];
        // setImmediate — чтобы question успел повесить слушатель строки.
        setImmediate(() => input.write(line + '\n'));
      }
      callback();
    },
  });
  const finished = runInteractive(
    client,
    config,
    {},
    false,
    temperature,
    stream,
    memory,
    keepRecent,
    session,
    store,
    input,
    output,
    readline.createInterface,
    memorySettings ?? { enabled: false, profileStore: null, taskStore: null },
  );
  return { finished, text: () => buffer };
}
