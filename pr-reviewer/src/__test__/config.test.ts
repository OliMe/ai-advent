import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadReviewConfig, parsePlatform, parseMinSeverity } from '../index.ts';

describe('parsePlatform', () => {
  it('gitlab только для явного значения, иначе github', () => {
    assert.equal(parsePlatform('gitlab'), 'gitlab');
    assert.equal(parsePlatform(' GitLab '), 'gitlab');
    assert.equal(parsePlatform('github'), 'github');
    assert.equal(parsePlatform(undefined), 'github');
    assert.equal(parsePlatform('что-то'), 'github');
  });
});

describe('parseMinSeverity', () => {
  it('известная категория, иначе nitpick (порог не режет)', () => {
    assert.equal(parseMinSeverity('bug'), 'bug');
    assert.equal(parseMinSeverity(' Architecture '), 'architecture');
    assert.equal(parseMinSeverity(undefined), 'nitpick');
    assert.equal(parseMinSeverity('выдумка'), 'nitpick');
  });
});

describe('loadReviewConfig', () => {
  it('дефолты github без переменных', () => {
    const config = loadReviewConfig({}, '/work/repo');
    assert.deepEqual(config, {
      platform: 'github',
      apiBaseUrl: 'https://api.github.com',
      token: '',
      repo: '',
      prNumber: 0,
      workingDir: '/work/repo',
      maxTokens: 2048,
      temperature: 0.2,
      topKDocs: 5,
      disableThinking: false,
      minSeverity: 'nitpick',
      maxInline: 20,
    });
  });

  it('PR_REVIEW_MIN_SEVERITY и PR_REVIEW_MAX_INLINE', () => {
    const config = loadReviewConfig(
      { PR_REVIEW_MIN_SEVERITY: 'architecture', PR_REVIEW_MAX_INLINE: '5' },
      '/x',
    );
    assert.equal(config.minSeverity, 'architecture');
    assert.equal(config.maxInline, 5);
  });

  it('переменные окружения переопределяют, base URL без хвостового слэша', () => {
    const config = loadReviewConfig(
      {
        PR_REVIEW_PLATFORM: 'github',
        GITHUB_API_URL: 'https://ghe.corp.example/api/v3/',
        GITHUB_TOKEN: 'tok',
        GITHUB_REPOSITORY: 'owner/name',
        PR_REVIEW_PR_NUMBER: '42',
        PR_REVIEW_MAX_TOKENS: '4096',
        PR_REVIEW_TEMPERATURE: '0.1',
        PR_REVIEW_TOP_K_DOCS: '8',
        PR_REVIEW_NO_THINKING: '1',
        PR_REVIEW_WORKDIR: '/checkout',
      },
      '/cwd',
    );
    assert.equal(config.apiBaseUrl, 'https://ghe.corp.example/api/v3');
    assert.equal(config.token, 'tok');
    assert.equal(config.repo, 'owner/name');
    assert.equal(config.prNumber, 42);
    assert.equal(config.maxTokens, 4096);
    assert.equal(config.temperature, 0.1);
    assert.equal(config.topKDocs, 8);
    assert.equal(config.disableThinking, true);
    assert.equal(config.workingDir, '/checkout');
  });

  it('gitlab: дефолтная база v4, CI_API_V4_URL для self-hosted', () => {
    assert.equal(
      loadReviewConfig({ PR_REVIEW_PLATFORM: 'gitlab' }, '/x').apiBaseUrl,
      'https://gitlab.com/api/v4',
    );
    const corp = loadReviewConfig(
      { PR_REVIEW_PLATFORM: 'gitlab', CI_API_V4_URL: 'https://gitlab.sima-land.ru/api/v4' },
      '/x',
    );
    assert.equal(corp.apiBaseUrl, 'https://gitlab.sima-land.ru/api/v4');
  });

  it('невалидные числа → дефолты, границы зажаты', () => {
    const config = loadReviewConfig(
      { PR_REVIEW_MAX_TOKENS: 'много', PR_REVIEW_TEMPERATURE: '-1', PR_REVIEW_TOP_K_DOCS: '999' },
      '/x',
    );
    assert.equal(config.maxTokens, 2048);
    assert.equal(config.temperature, 0.2);
    assert.equal(config.topKDocs, 50);
  });

  it('PR_REVIEW_TOKEN приоритетнее GITHUB_TOKEN, PR_REVIEW_API_URL — базы платформы', () => {
    const config = loadReviewConfig(
      { PR_REVIEW_TOKEN: 'a', GITHUB_TOKEN: 'b', PR_REVIEW_API_URL: 'https://x/api' },
      '/x',
    );
    assert.equal(config.token, 'a');
    assert.equal(config.apiBaseUrl, 'https://x/api');
  });

  it('GH_TOKEN как запасной токен, PR_REVIEW_REPO приоритетнее GITHUB_REPOSITORY', () => {
    const config = loadReviewConfig(
      { GH_TOKEN: 'gh', PR_REVIEW_REPO: 'o/r', GITHUB_REPOSITORY: 'other/x' },
      '/x',
    );
    assert.equal(config.token, 'gh');
    assert.equal(config.repo, 'o/r');
  });
});
