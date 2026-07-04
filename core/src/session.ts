import { randomBytes } from 'node:crypto';
import type { ChatMessage } from './types.ts';

/** Версия формата файла сессии — для будущих миграций. */
export const SESSION_VERSION = 1;

/** Сохранённый диалог: полный транскрипт, включая системное сообщение. */
export interface Session {
  version: number;
  id: string;
  /** Модель, которой велась сессия. */
  model: string;
  /** Осмысленное имя ветки для удобного переключения (напр. «main»). */
  label?: string;
  /** id задачи, к которой привязана сессия (если есть). */
  taskId?: string;
  /**
   * Привязанные источники RAG для grounded-режима мини-чата (День 25): наличие непустого списка =
   * режим включён (на каждой содержательной реплике идёт поиск по этим источникам). Персистится в
   * файле сессии — режим и база переживают перезапуск и переключение сессий.
   */
  ragSources?: string[];
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

/** Короткая сводка сессии для списка — без полного содержимого. */
export interface SessionSummary {
  id: string;
  model: string;
  /** Имя ветки (если задано). */
  label?: string;
  createdAt: string;
  updatedAt: string;
  /** Превью первого пользовательского сообщения. */
  preview: string;
  /** Число сообщений (вместе с системным). */
  messageCount: number;
}

/** Дополнение числа нулём до двух знаков. */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Сортируемый id сессии: UTC-метка времени + случайный суффикс. */
export function sessionId(date: Date, suffix: string): string {
  const stamp =
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  return `${stamp}-${suffix}`;
}

/** Случайный суффикс id (6 hex-символов). */
function randomSuffix(): string {
  return randomBytes(3).toString('hex');
}

/** Создаёт новую сессию с заданными моделью, сообщениями и (опционально) именем ветки. */
export function createSession(
  model: string,
  messages: ChatMessage[],
  now: Date = new Date(),
  idSuffix: string = randomSuffix(),
  label?: string,
): Session {
  const timestamp = now.toISOString();
  return {
    version: SESSION_VERSION,
    id: sessionId(now, idSuffix),
    model,
    ...(label === undefined ? {} : { label }),
    createdAt: timestamp,
    updatedAt: timestamp,
    messages,
  };
}

/** Превью первого пользовательского сообщения — одной строкой, обрезанное. */
export function sessionPreview(session: Session, maxLength = 60): string {
  const firstUserMessage = session.messages.find(message => message.role === 'user');
  if (firstUserMessage === undefined) {
    return '';
  }
  const text = firstUserMessage.content.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Строит сводку сессии для списка. */
export function summarize(session: Session): SessionSummary {
  return {
    id: session.id,
    model: session.model,
    ...(session.label === undefined ? {} : { label: session.label }),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    preview: sessionPreview(session),
    messageCount: session.messages.length,
  };
}
