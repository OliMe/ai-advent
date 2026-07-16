import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadSupportConfig } from '../index.ts';

describe('loadSupportConfig', () => {
  it('дефолты при пустом окружении', () => {
    assert.deepEqual(loadSupportConfig({}), {
      provider: 'github',
      apiBaseUrl: 'https://api.github.com',
      repo: '',
      token: '',
      maxOutputChars: 8000,
      timeoutMs: 30000,
      maxRetries: 3,
      retryBaseMs: 500,
    });
  });

  it('SUPPORT_* приоритетнее, хвостовой слэш базы срезается, число в границах и зажим сверху', () => {
    const config = loadSupportConfig({
      SUPPORT_API_URL: 'https://ghe.corp/api/v3/',
      GITHUB_API_URL: 'https://api.github.com',
      SUPPORT_REPO: 'owner/name',
      GITHUB_REPOSITORY: 'other/x',
      SUPPORT_TOKEN: 'tok',
      SUPPORT_TIMEOUT_MS: '5000',
      SUPPORT_MAX_OUTPUT_CHARS: '999999999',
    });
    assert.equal(config.apiBaseUrl, 'https://ghe.corp/api/v3');
    assert.equal(config.repo, 'owner/name');
    assert.equal(config.token, 'tok');
    assert.equal(config.timeoutMs, 5000);
    assert.equal(config.maxOutputChars, 200000); // зажат к максимуму
  });

  it('GITHUB_* как запасные (база из GITHUB_API_URL, репозиторий, токен)', () => {
    const config = loadSupportConfig({
      GITHUB_API_URL: 'https://api.github.com',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_TOKEN: 'ght',
    });
    assert.equal(config.apiBaseUrl, 'https://api.github.com');
    assert.equal(config.repo, 'o/r');
    assert.equal(config.token, 'ght');
  });

  it('GH_TOKEN как последний запасной; невалидное число → дефолт; зажим снизу', () => {
    const config = loadSupportConfig({
      GH_TOKEN: 'gh',
      SUPPORT_TIMEOUT_MS: 'не число',
      SUPPORT_MAX_RETRIES: '-5',
    });
    assert.equal(config.token, 'gh');
    assert.equal(config.timeoutMs, 30000); // фолбэк
    assert.equal(config.maxRetries, 0); // зажат к минимуму
  });
});
