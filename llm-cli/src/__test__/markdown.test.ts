import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownForTerminal } from '../index.ts';

describe('renderMarkdownForTerminal', () => {
  it('вне TTY возвращает текст без изменений (markdown как есть)', () => {
    const source = '**жирный** и `код` и ## Заголовок';
    assert.equal(renderMarkdownForTerminal(source, false), source);
  });

  it('жирный **…** → ANSI bold', () => {
    assert.equal(
      renderMarkdownForTerminal('**Купить гречку**', true),
      '\x1b[1mКупить гречку\x1b[22m',
    );
  });

  it('жирный __…__ → ANSI bold (вторая ветка альтернативы)', () => {
    assert.equal(
      renderMarkdownForTerminal('__Завтра 09:00__', true),
      '\x1b[1mЗавтра 09:00\x1b[22m',
    );
  });

  it('инлайн-код `…` → ANSI dim', () => {
    assert.equal(
      renderMarkdownForTerminal('id: `8173b235a134`', true),
      'id: \x1b[2m8173b235a134\x1b[22m',
    );
  });

  it('заголовки #..###### → ANSI bold без решёток', () => {
    assert.equal(renderMarkdownForTerminal('## Твои дела', true), '\x1b[1mТвои дела\x1b[22m');
    assert.equal(
      renderMarkdownForTerminal('### 🔔 Напоминания', true),
      '\x1b[1m🔔 Напоминания\x1b[22m',
    );
  });

  it('комбинированный фрагмент: заголовок + жирный + код', () => {
    const rendered = renderMarkdownForTerminal('# Дела\n- **9:00** — гречка (id: `abc`)', true);
    assert.match(rendered, /\x1b\[1mДела\x1b\[22m/);
    assert.match(rendered, /\x1b\[1m9:00\x1b\[22m/);
    assert.match(rendered, /\x1b\[2mabc\x1b\[22m/);
  });
});
