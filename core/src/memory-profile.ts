import { emptyProfile, summarizeProfile, DEFAULT_PROFILE_NAME } from './profile-store.ts';
import type { Profile, ProfileStore, ProfileSummary } from './profile-store.ts';
import type { ChatMessage } from './types.ts';
import { capToBudget } from './tokens.ts';

/**
 * Долговременный слой памяти (персоны): владеет активным профилем, его хранилищем
 * и индексом профилей процесса (для in-memory режима). Переключение/создание/
 * удаление/переименование профилей, добавление черт, консолидация и рендер блока.
 */
export class ProfileMemory {
  private readonly store: ProfileStore | null;
  // Активный профиль; его имя — profile.name.
  private profile: Profile;
  private readonly profiles = new Map<string, Profile>();

  constructor(profile: Profile, store: ProfileStore | null) {
    this.profile = profile;
    this.store = store;
    this.profiles.set(profile.name, profile); // in-memory кэш активного
  }

  /** Имя активного профиля (персоны). */
  currentName(): string {
    return this.profile.name;
  }

  /** Пункты активного профиля. */
  entries(): string[] {
    return this.profile.entries.map(entry => entry.text);
  }

  /** Сохраняет активный профиль (в хранилище или в индекс процесса). */
  private persist(): void {
    if (this.store !== null) {
      this.store.save(this.profile);
    } else {
      this.profiles.set(this.profile.name, this.profile);
    }
  }

  /** Список профилей (из хранилища или из памяти процесса), свежие первыми. */
  list(): ProfileSummary[] {
    if (this.store !== null) {
      return this.store.list();
    }
    return [...this.profiles.values()]
      .map(summarizeProfile)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Есть ли профиль с таким именем. */
  private exists(name: string): boolean {
    return this.store !== null
      ? this.store.list().some(summary => summary.name === name)
      : this.profiles.has(name);
  }

  /** Удаляет профиль из хранилища и индекса процесса. */
  private remove(name: string): void {
    this.profiles.delete(name);
    this.store?.delete(name);
  }

  /**
   * Делает активным профиль с именем `name`, создавая пустой, если его нет.
   * Возвращает true, если профиль был создан. Активный профиль персистится глобально.
   */
  switch(name: string): boolean {
    const created = !this.exists(name);
    this.profile =
      this.store !== null ? this.store.load(name) : (this.profiles.get(name) ?? emptyProfile(name));
    if (created) {
      this.persist(); // создаём пустой, чтобы попал в список и активировался
    }
    this.store?.setActive(name);
    return created;
  }

  /**
   * Удаляет профиль по имени. Если удалили активный — переключаемся на «default».
   * Возвращает true, если профиль существовал и был удалён.
   */
  delete(name: string): boolean {
    if (!this.exists(name)) {
      return false;
    }
    this.remove(name);
    if (this.profile.name === name) {
      this.switch(DEFAULT_PROFILE_NAME); // активный удалён — на default
    }
    return true;
  }

  /**
   * Переименовывает активный профиль. 'same' — имя не изменилось, 'taken' — имя
   * занято другим профилем, 'ok' — переименовано (старый файл удаляется).
   */
  rename(newName: string): 'ok' | 'same' | 'taken' {
    const oldName = this.profile.name;
    if (newName === oldName) {
      return 'same';
    }
    if (this.exists(newName)) {
      return 'taken';
    }
    this.profile = { ...this.profile, name: newName, updatedAt: new Date().toISOString() };
    this.persist(); // сохраняем под новым именем
    this.remove(oldName); // убираем старый
    this.store?.setActive(newName);
    return 'ok';
  }

  /**
   * Забывает пункты профиля по номерам (1-based). Резолвит индексы ДО удаления,
   * чтобы их сдвиг не мешал; невалидные игнорирует. Возвращает забытые тексты
   * (в порядке возрастания номера).
   */
  forget(oneBasedIndices: number[]): string[] {
    const drop = new Set<number>();
    for (const oneBased of oneBasedIndices) {
      const index = oneBased - 1;
      if (index >= 0 && index < this.profile.entries.length) {
        drop.add(index);
      }
    }
    if (drop.size === 0) {
      return [];
    }
    const removed = [...drop].sort((a, b) => a - b).map(index => this.profile.entries[index].text);
    this.profile.entries = this.profile.entries.filter((_, index) => !drop.has(index));
    this.profile.updatedAt = new Date().toISOString();
    this.persist();
    return removed;
  }

  /**
   * Добавляет в профиль новые черты (с дедупликацией). Возвращает добавленные
   * тексты. Только строки; пустые и дубли отбрасываются.
   */
  addTraits(rawTraits: unknown[]): string[] {
    const known = new Set(this.profile.entries.map(entry => entry.text));
    const added: string[] = [];
    const now = new Date().toISOString();
    for (const trait of rawTraits) {
      if (typeof trait === 'string' && trait.trim() && !known.has(trait.trim())) {
        this.profile.entries.push({ text: trait.trim(), updatedAt: now });
        known.add(trait.trim());
        added.push(trait.trim());
      }
    }
    if (added.length > 0) {
      this.profile.updatedAt = now;
      this.persist();
    }
    return added;
  }

  /** Полностью заменяет пункты профиля (консолидация в конце сессии). */
  replace(texts: string[]): void {
    const now = new Date().toISOString();
    this.profile = {
      ...this.profile,
      entries: texts.map(text => ({ text, updatedAt: now })),
      updatedAt: now,
    };
    this.persist();
  }

  /** Системный блок профиля (или null, если пусто). */
  block(budgetTokens: number): ChatMessage | null {
    if (this.profile.entries.length === 0) {
      return null;
    }
    const body = capToBudget(
      this.profile.entries.map(entry => `- ${entry.text}`).join('\n'),
      budgetTokens,
    );
    return { role: 'system', content: `Профиль пользователя:\n${body}` };
  }
}
