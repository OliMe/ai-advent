import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTavilyApiKey, serverEnvironment, tavilyServerParameters } from '../index.ts';

describe('resolveTavilyApiKey', () => {
  it('возвращает ключ из окружения, обрезая пробелы', () => {
    assert.equal(
      resolveTavilyApiKey({ TAVILY_API_KEY: '  tvly-1  ' } as NodeJS.ProcessEnv),
      'tvly-1',
    );
  });

  it('бросает понятную ошибку, если ключ не задан или пуст', () => {
    assert.throws(() => resolveTavilyApiKey({} as NodeJS.ProcessEnv), /TAVILY_API_KEY/);
    assert.throws(
      () => resolveTavilyApiKey({ TAVILY_API_KEY: '   ' } as NodeJS.ProcessEnv),
      /TAVILY_API_KEY/,
    );
  });
});

describe('serverEnvironment', () => {
  it('кладёт ключ и форвардит только заданные системные переменные', () => {
    const environment = serverEnvironment('tvly-1', {
      PATH: '/usr/bin',
      HOME: '/home/u',
      APPDATA: undefined,
    } as NodeJS.ProcessEnv);
    assert.equal(environment.TAVILY_API_KEY, 'tvly-1');
    assert.equal(environment.PATH, '/usr/bin');
    assert.equal(environment.HOME, '/home/u');
    assert.equal('APPDATA' in environment, false); // не задано в окружении — не пробрасываем
  });
});

describe('tavilyServerParameters', () => {
  it('описывает запуск tavily-mcp через npx с подготовленным окружением', () => {
    const parameters = tavilyServerParameters('tvly-1', { PATH: '/usr/bin' } as NodeJS.ProcessEnv);
    assert.equal(parameters.command, 'npx');
    assert.deepEqual(parameters.args, ['-y', 'tavily-mcp']);
    assert.equal(parameters.env.TAVILY_API_KEY, 'tvly-1');
  });
});
