import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, validTemperature } from '../index.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('validTemperature', () => {
  it('принимает конечное неотрицательное число', () => {
    assert.equal(validTemperature('0.4'), 0.4);
    assert.equal(validTemperature('1.5'), 1.5);
  });

  it('отвергает отрицательные значения и нечисла', () => {
    assert.equal(validTemperature('-1'), null);
    assert.equal(validTemperature('abc'), null);
  });
});

describe('parseArgs', () => {
  it('без флагов собирает промпт из слов, ограничений нет', () => {
    const result = parseArgs(['привет', 'мир']);
    assert.equal(result.prompt, 'привет мир');
    assert.deepEqual(result.limits, {});
    assert.equal(result.disableThinking, false);
    assert.equal(result.temperature, undefined);
  });

  it('--temperature принимает число (= и пробел)', () => {
    assert.equal(parseArgs(['--temperature=0.2']).temperature, 0.2);
    assert.equal(parseArgs(['--temperature', '1.5']).temperature, 1.5);
  });

  it('бросает ошибку при невалидной --temperature', () => {
    assert.throws(() => parseArgs(['--temperature=-1']), /неотрицательное число/);
    assert.throws(() => parseArgs(['--temperature=abc']), /неотрицательное число/);
  });

  it('--no-thinking включает отключение рассуждений', () => {
    const result = parseArgs(['--no-thinking', 'привет']);
    assert.equal(result.prompt, 'привет');
    assert.equal(result.disableThinking, true);
  });

  it('--no-stream выключает потоковый вывод; по умолчанию он включён', () => {
    assert.equal(parseArgs(['--no-stream', 'привет']).stream, false);
    assert.equal(parseArgs(['привет']).stream, true);
  });

  it('--no-mcp булев; по умолчанию выключен', () => {
    assert.equal(parseArgs(['--no-mcp']).noMcp, true);
    assert.equal(parseArgs(['привет']).noMcp, false);
  });

  it('--ephemeral булев; по умолчанию выключен, ветка не задана', () => {
    assert.equal(parseArgs(['--ephemeral']).ephemeral, true);
    const none = parseArgs(['привет']);
    assert.equal(none.ephemeral, false);
    assert.equal(none.switchTo, undefined);
    assert.equal(none.branchName, undefined);
  });

  it('--switch без значения = last, с = задаёт имя/id', () => {
    assert.equal(parseArgs(['--switch']).switchTo, 'last');
    assert.equal(parseArgs(['--switch=alpha']).switchTo, 'alpha');
    assert.equal(parseArgs(['--switch=20260610T100000-ab']).switchTo, '20260610T100000-ab');
  });

  it('--branch задаёт имя новой ветки', () => {
    assert.equal(parseArgs(['--branch=alpha']).branchName, 'alpha');
    assert.equal(parseArgs(['--branch', 'beta']).branchName, 'beta');
    assert.equal(parseArgs(['привет']).branchName, undefined);
  });

  it('флаги слоистой памяти: --no-memory, --task, --profile-tokens, --task-tokens', () => {
    const a = parseArgs(['--no-memory']);
    assert.equal(a.noMemory, true);
    assert.equal(parseArgs(['привет']).noMemory, false);

    assert.equal(parseArgs(['--task', 'Сделать сайт']).task, 'Сделать сайт');
    assert.equal(parseArgs(['--task=Бот']).task, 'Бот');
    assert.equal(parseArgs(['привет']).task, undefined);

    assert.equal(parseArgs(['--profile-tokens=300']).profileTokens, 300);
    assert.equal(parseArgs(['--task-tokens=700']).taskTokens, 700);
    assert.equal(parseArgs(['привет']).profileTokens, undefined);
    assert.equal(parseArgs(['привет']).taskTokens, undefined);

    assert.equal(parseArgs(['--profile', 'работа']).profile, 'работа');
    assert.equal(parseArgs(['--profile=личное']).profile, 'личное');
    assert.equal(parseArgs(['привет']).profile, undefined);
  });

  it('--json включает формат json_object', () => {
    const result = parseArgs(['--json', 'дай', 'json']);
    assert.equal(result.prompt, 'дай json');
    assert.deepEqual(result.limits.responseFormat, { type: 'json_object' });
  });

  it('--max-tokens принимает значение через = и через пробел', () => {
    assert.equal(parseArgs(['--max-tokens=200']).limits.maxTokens, 200);
    assert.equal(parseArgs(['--max-tokens', '300']).limits.maxTokens, 300);
  });

  it('единственный --stop даёт строку, несколько — массив', () => {
    assert.equal(parseArgs(['--stop', '###']).limits.stop, '###');
    assert.deepEqual(parseArgs(['--stop', 'A', '--stop=B']).limits.stop, ['A', 'B']);
  });

  it('--file можно указать несколько раз', () => {
    const result = parseArgs(['--file', 'a.txt', '--file=b.txt', 'вопрос']);
    assert.deepEqual(result.files, ['a.txt', 'b.txt']);
    assert.equal(result.prompt, 'вопрос');
  });

  it('--memory принимает window/summary/facts; по умолчанию window', () => {
    assert.equal(parseArgs(['--memory=summary']).memory, 'summary');
    assert.equal(parseArgs(['--memory', 'window']).memory, 'window');
    assert.equal(parseArgs(['--memory=facts']).memory, 'facts');
    assert.equal(parseArgs(['привет']).memory, 'window');
  });

  it('--memory отвергает иные значения', () => {
    assert.throws(() => parseArgs(['--memory=foo']), /window, summary или facts/);
  });

  it('--keep-recent принимает положительное целое; по умолчанию задан', () => {
    assert.equal(parseArgs(['--keep-recent=3']).keepRecent, 3);
    assert.equal(typeof parseArgs(['привет']).keepRecent, 'number');
  });

  it('--keep-recent отвергает невалидное', () => {
    assert.throws(() => parseArgs(['--keep-recent=0']), /положительное целое/);
  });

  it('бросает ошибку при невалидном --max-tokens', () => {
    assert.throws(() => parseArgs(['--max-tokens=0']), /положительное целое/);
    assert.throws(() => parseArgs(['--max-tokens=abc']), /положительное целое/);
  });

  it('--context-tokens принимает значение через = и через пробел', () => {
    assert.equal(parseArgs(['--context-tokens=4096']).contextTokens, 4096);
    assert.equal(parseArgs(['--context-tokens', '8192']).contextTokens, 8192);
  });

  it('бросает ошибку при невалидном --context-tokens', () => {
    assert.throws(() => parseArgs(['--context-tokens=0']), /положительное целое/);
    assert.throws(() => parseArgs(['--context-tokens=abc']), /положительное целое/);
  });

  it('бросает ошибку, если у флага нет значения', () => {
    assert.throws(() => parseArgs(['--max-tokens']), /Не указано значение/);
  });

  it('бросает ошибку на неизвестном флаге', () => {
    assert.throws(() => parseArgs(['--unknown=1']), /Неизвестный флаг/);
  });

  it('--json-schema читает файл и строит строгий response_format', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-schema-'));
    try {
      const file = join(dir, 'schema.json');
      const schema = { type: 'object', properties: { city: { type: 'string' } } };
      writeFileSync(file, JSON.stringify(schema));

      const { limits } = parseArgs([`--json-schema=${file}`]);

      assert.deepEqual(limits.responseFormat, {
        type: 'json_schema',
        json_schema: { name: 'response', strict: true, schema },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--json-schema бросает ошибку, если файл не найден', () => {
    assert.throws(
      () => parseArgs(['--json-schema=/нет/такого/файла.json']),
      /прочитать файл схемы/,
    );
  });

  it('--json-schema бросает ошибку при невалидном JSON в файле', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-schema-'));
    try {
      const file = join(dir, 'bad.json');
      writeFileSync(file, '{ не json');
      assert.throws(() => parseArgs([`--json-schema=${file}`]), /Невалидный JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
