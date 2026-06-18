import { createSession } from '../../core/src/index.ts';
import type { AppConfig, GenerationLimits, Session, SessionStore } from '../../core/src/index.ts';
import { augmentSystemPrompt } from './chat.ts';

/** Имя ветки по умолчанию — точка возврата к исходному диалогу. */
const DEFAULT_BRANCH_LABEL = 'main';

/** Новая сессия (ветка «main») с системным сообщением из текущего конфига. */
export function newSession(config: AppConfig, limits: GenerationLimits): Session {
  return createSession(
    config.model,
    [{ role: 'system', content: augmentSystemPrompt(config.systemPrompt, limits) }],
    undefined,
    undefined,
    DEFAULT_BRANCH_LABEL,
  );
}

/** Занято ли имя ветки среди сохранённых сессий. */
export function branchNameTaken(store: SessionStore, name: string): boolean {
  return store.list().some(summary => summary.label === name);
}

/** Находит ветку по имени (label), а если не нашлось — по id. */
export function resolveBranch(store: SessionStore, nameOrId: string): Session | null {
  const byLabel = store.list().find(summary => summary.label === nameOrId);
  return byLabel ? store.load(byLabel.id) : store.load(nameOrId);
}

/**
 * Готовит сессию для старта: продолжение существующей ветки (`switchTo` — имя/id
 * или 'last') и/или ответвление в новую именованную ветку (`branchName`). Без
 * хранилища или без обоих параметров — новая ветка «main». Имя для ветвления
 * должно быть свободно; несуществующая ветка для switchTo — ошибка.
 */
export function resolveSession(
  store: SessionStore | null,
  config: AppConfig,
  limits: GenerationLimits,
  switchTo: string | undefined,
  branchName: string | undefined,
): Session {
  if (store === null || (switchTo === undefined && branchName === undefined)) {
    return newSession(config, limits);
  }

  // База: целевая ветка (--switch имя/id/last) либо последняя по времени.
  let base: Session | null;
  if (switchTo !== undefined) {
    base = switchTo === 'last' ? store.latest() : resolveBranch(store, switchTo);
    if (base === null && switchTo !== 'last') {
      throw new Error(`Ветка не найдена: ${switchTo}`);
    }
  } else {
    base = store.latest();
  }

  if (branchName !== undefined) {
    if (branchNameTaken(store, branchName)) {
      throw new Error(`Ветка «${branchName}» уже существует`);
    }
    const model = base?.model ?? config.model;
    const messages = base ? [...base.messages] : newSession(config, limits).messages;
    return createSession(model, messages, undefined, undefined, branchName);
  }
  return base ?? newSession(config, limits);
}
