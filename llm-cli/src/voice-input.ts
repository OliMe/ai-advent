/**
 * Абстракции голосового ввода (типы — реализация записи через ffmpeg собирается в тонком cli.ts,
 * распознавание — в yandex-speech.ts). Разделение даёт тестируемость: интерактив работает с
 * этими интерфейсами, а в тестах подставляются фейки.
 */

/** Идёт запись звука; finish завершает её и отдаёт записанный звук (OggOpus). */
export interface RecordingSession {
  finish(): Promise<Uint8Array>;
}

/** Источник записи с микрофона (обёртка над ffmpeg; инжектируется). */
export interface AudioRecorder {
  /** Начинает запись и возвращает управление её завершением. */
  start(): RecordingSession;
}

/** Голосовой ввод: запись с микрофона + распознавание записанного в текст. */
export interface VoiceInput {
  recorder: AudioRecorder;
  /** Распознаёт записанный звук в текст. */
  transcribe(audio: Uint8Array): Promise<string>;
}
