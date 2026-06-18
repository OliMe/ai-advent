import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Каталог хранения сессий: из LLM_SESSION_DIR или `~/.llm-cli/sessions`. */
export function sessionDirectory(): string {
  return process.env.LLM_SESSION_DIR?.trim() || join(homedir(), '.llm-cli', 'sessions');
}

/** Базовый каталог памяти (рядом с сессиями): родитель каталога сессий. */
function memoryBaseDir(): string {
  return dirname(sessionDirectory());
}

/** Путь к файлу долговременного профиля пользователя (легаси, до мультипрофилей). */
export function profilePath(): string {
  return join(memoryBaseDir(), 'profile.json');
}

/** Каталог хранения задач. */
export function tasksDirectory(): string {
  return join(memoryBaseDir(), 'tasks');
}

/** Каталог хранения профилей (персон). */
export function profilesDirectory(): string {
  return join(memoryBaseDir(), 'profiles');
}
