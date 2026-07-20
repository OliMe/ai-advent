import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  historyTokens,
  requestCostUsd,
  formatUsageStats,
  formatSessionTotals,
  historyBudgetTokens,
  trimHistoryToBudget,
  offloadOldToolResults,
} from '../index.ts';
import { makeConfig } from './helpers.ts';
import type { ChatMessage, Usage } from '../index.ts';

describe('estimateTokens', () => {
  it('оценивает число токенов как ceil(длина / 3)', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('абвгде'), 2);
    assert.equal(estimateTokens('абвг'), 2); // ceil(4/3)
  });
});

describe('historyTokens / requestCostUsd / formatUsageStats', () => {
  it('historyTokens суммирует оценку по сообщениям (с накладными)', () => {
    const tokens = historyTokens([
      { role: 'system', content: 'абвгде' }, // ceil(6/3)=2 +4 = 6
      { role: 'user', content: 'абв' }, // ceil(3/3)=1 +4 = 5
    ]);
    assert.equal(tokens, 11);
  });

  it('requestCostUsd считает по тарифам $/1M', () => {
    const cost = requestCostUsd(
      { prompt_tokens: 1_000_000, completion_tokens: 2_000_000, total_tokens: 3_000_000 },
      makeConfig({ priceInputPer1M: 0.5, priceOutputPer1M: 1.5 }),
    );
    assert.equal(cost, 0.5 * 1 + 1.5 * 2); // 3.5
  });

  it('formatUsageStats: «н/д» при отсутствии usage', () => {
    assert.match(formatUsageStats(undefined, 42, makeConfig()), /токены: н\/д · история ~42/);
  });

  it('formatUsageStats: подсказка, когда тарифы не заданы', () => {
    const line = formatUsageStats(
      { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      100,
      makeConfig(),
    );
    assert.match(line, /вход 10 · выход 20 · история ~100/);
    assert.match(line, /задайте LLM_PRICE/);
  });

  it('formatUsageStats: стоимость в $ и ₽ при заданных тарифах', () => {
    const line = formatUsageStats(
      { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
      0,
      makeConfig({ priceInputPer1M: 2, priceOutputPer1M: 0, usdToRub: 100 }),
    );
    assert.match(line, /\$2\.000000 \/ 200\.0000 ₽/);
  });

  it('formatUsageStats: с меткой-префиксом (для строки сжатия)', () => {
    const line = formatUsageStats(
      { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
      0,
      makeConfig(),
      'сжатие',
    );
    assert.match(line, /\[сжатие · вход 7 · выход 5/);
  });

  it('formatUsageStats: скорость ток/с при заданном времени ответа', () => {
    // 60 токенов за 2000 мс = 30 ток/с.
    const line = formatUsageStats(
      { prompt_tokens: 10, completion_tokens: 60, total_tokens: 70 },
      0,
      makeConfig(),
      undefined,
      2000,
    );
    assert.match(line, /· 2\.0с · 30 ток\/с/);
  });

  it('formatUsageStats: скорость НЕ показывается без времени, при нулевом времени и без токенов выхода', () => {
    const usage = { prompt_tokens: 10, completion_tokens: 60, total_tokens: 70 };
    // время не задано
    assert.doesNotMatch(formatUsageStats(usage, 0, makeConfig()), /ток\/с/);
    // время нулевое
    assert.doesNotMatch(formatUsageStats(usage, 0, makeConfig(), undefined, 0), /ток\/с/);
    // нет токенов выхода — делить не на что показывать
    assert.doesNotMatch(
      formatUsageStats(
        { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
        0,
        makeConfig(),
        undefined,
        1000,
      ),
      /ток\/с/,
    );
  });

  it('formatSessionTotals: суммарные токены без тарифов', () => {
    const line = formatSessionTotals(
      { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      makeConfig(),
    );
    assert.match(line, /Итого за сессию: вход 10 · выход 20 · всего 30/);
  });

  it('formatSessionTotals: со стоимостью при заданных тарифах', () => {
    const line = formatSessionTotals(
      { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
      makeConfig({ priceInputPer1M: 2, priceOutputPer1M: 0, usdToRub: 100 }),
    );
    assert.match(line, /\$2\.000000 \/ 200\.0000 ₽/);
  });
});

describe('historyBudgetTokens', () => {
  it('вычитает явный резерв под ответ из контекста', () => {
    assert.equal(historyBudgetTokens(8192, 1000), 7192);
  });

  it('при отсутствии --max-tokens вычитает дефолтный резерв', () => {
    assert.equal(historyBudgetTokens(8192), 8192 - 1024);
  });

  it('не опускается ниже минимума', () => {
    assert.equal(historyBudgetTokens(100), 256);
  });
});

describe('trimHistoryToBudget', () => {
  const system: ChatMessage = { role: 'system', content: 'сис' };
  const turn = (role: ChatMessage['role'], n: number): ChatMessage => ({
    role,
    content: `${role}-${n} ${'x'.repeat(60)}`,
  });

  it('сохраняет всё, когда укладывается в бюджет', () => {
    const history = [system, turn('user', 1), turn('assistant', 1)];
    assert.deepEqual(trimHistoryToBudget(history, 10_000), history);
  });

  it('сохраняет систему и свежие реплики, отбрасывая старые', () => {
    const history = [system, turn('user', 1), turn('assistant', 1), turn('user', 2)];
    const result = trimHistoryToBudget(history, 60);

    assert.equal(result[0], system); // система всегда первая
    assert.ok(result.some(message => message.content.startsWith('user-2'))); // свежий ход
    assert.ok(!result.some(message => message.content.startsWith('user-1'))); // старый выпал
  });

  it('сохраняет последнее сообщение, даже если оно превышает бюджет', () => {
    const history = [system, turn('user', 1)];
    const result = trimHistoryToBudget(history, 1);

    assert.equal(result.length, 2); // система + последний ход
    assert.ok(result.some(message => message.content.startsWith('user-1')));
  });

  it('не оставляет осиротевший tool-ответ в начале окна (обрезан его assistant с tool_calls)', () => {
    const assistantWithCalls: ChatMessage = {
      role: 'assistant',
      content: `assistant-1 ${'x'.repeat(60)}`,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    };
    const toolReply: ChatMessage = { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(60) };
    const history = [system, assistantWithCalls, toolReply, turn('user', 2)];
    // Бюджет вмещает только систему + пару свежих сообщений — assistant с tool_calls выпадет.
    const result = trimHistoryToBudget(history, 70);

    assert.equal(result[0], system);
    // Первое НЕсистемное сообщение не должно быть tool (иначе провайдер вернёт 400).
    assert.notEqual(result[1]?.role, 'tool');
    assert.ok(result.some(message => message.content.startsWith('user-2'))); // свежий ход остался
  });

  it('оставляет группу tool-вызова целиком, если её assistant попал в окно', () => {
    const assistantWithCalls: ChatMessage = {
      role: 'assistant',
      content: 'assistant-1',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    };
    const toolReply: ChatMessage = { role: 'tool', tool_call_id: 'c1', content: 'итог' };
    const history = [system, assistantWithCalls, toolReply];
    const result = trimHistoryToBudget(history, 10_000); // всё влезает

    assert.deepEqual(result, history); // группа не тронута
  });
});

describe('offloadOldToolResults', () => {
  const sys: ChatMessage = { role: 'system', content: 'сис' };
  const user: ChatMessage = { role: 'user', content: 'задача и план' };
  const call = (id: string): ChatMessage => ({
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
  });
  const tool = (id: string, length: number): ChatMessage => ({
    role: 'tool',
    tool_call_id: id,
    content: 'x'.repeat(length),
  });

  it('под бюджетом → возвращает тот же массив без изменений', () => {
    const history = [sys, user, call('c1'), tool('c1', 900)];
    assert.equal(offloadOldToolResults(history, 100_000, 1), history); // та же ссылка
  });

  it('над бюджетом → старые объёмные tool-результаты заменены плейсхолдером, свежие целы', () => {
    const history = [
      sys,
      user,
      call('c1'),
      tool('c1', 900),
      call('c2'),
      tool('c2', 900),
      call('c3'),
      tool('c3', 900),
    ];
    const result = offloadOldToolResults(history, 100, 1); // держим инлайн последний 1 результат
    assert.notEqual(result, history); // новый массив
    assert.equal(result.length, history.length); // длина/порядок сохранены
    assert.match(result[3].content, /вытеснен для экономии контекста/); // c1 (старый) вытеснен
    assert.match(result[3].content, /было ~900 симв/); // плейсхолдер несёт исходный размер
    assert.equal(result[3].tool_call_id, 'c1'); // tool_call_id сохранён (структура цела)
    assert.match(result[5].content, /вытеснен/); // c2 (старый) вытеснен
    assert.equal(result[7].content, 'x'.repeat(900)); // c3 (свежий) НЕ тронут
    assert.equal(result[0], sys); // system нетронут (та же ссылка)
    assert.equal(result[1], user); // user-якорь нетронут
    assert.equal(result[2], history[2]); // assistant нетронут
  });

  it('короткий старый tool-результат не вытесняется (плейсхолдер был бы не короче)', () => {
    const history = [
      sys,
      user,
      call('c1'),
      tool('c1', 50), // короткий старый — ниже порога
      call('c2'),
      tool('c2', 900),
      call('c3'),
      tool('c3', 900),
    ];
    const result = offloadOldToolResults(history, 100, 1);
    assert.equal(result[3].content, 'x'.repeat(50)); // короткий c1 не тронут
    assert.match(result[5].content, /вытеснен/); // длинный c2 вытеснен
  });

  it('tool-результатов не больше keepRecent → ничего не вытесняется', () => {
    const history = [sys, user, call('c1'), tool('c1', 5000)];
    const result = offloadOldToolResults(history, 100, 4); // keepRecent > числа tool-сообщений
    assert.notEqual(result, history); // прошли порог бюджета → копия
    assert.equal(result[3].content, 'x'.repeat(5000)); // единственный (свежий) результат цел
  });
});
