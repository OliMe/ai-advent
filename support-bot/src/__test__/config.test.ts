import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadSupportBotConfig } from '../index.ts';

describe('loadSupportBotConfig', () => {
  it('дефолты: пути FAQ/кэша относительно пакета, база github', () => {
    assert.deepEqual(loadSupportBotConfig({}, '/pkg'), {
      repo: '',
      token: '',
      apiBaseUrl: 'https://api.github.com',
      issueNumber: 0,
      event: '',
      actor: '',
      faqDir: '/pkg/faq',
      cacheDir: '/pkg/.support-bot-cache',
      topKFaq: 5,
      disableThinking: false,
      codeSearch: false,
      ref: 'main',
      repoRoot: '',
    });
  });

  it('ref/repoRoot: GITHUB_SHA/GITHUB_WORKSPACE, оверрайд SUPPORT_REF/SUPPORT_REPO_ROOT', () => {
    const fromActions = loadSupportBotConfig(
      { GITHUB_SHA: 'abc123', GITHUB_WORKSPACE: '/runner/repo' },
      '/pkg',
    );
    assert.equal(fromActions.ref, 'abc123');
    assert.equal(fromActions.repoRoot, '/runner/repo');
    const overridden = loadSupportBotConfig(
      { GITHUB_SHA: 'abc123', SUPPORT_REF: 'v1', SUPPORT_REPO_ROOT: '/custom' },
      '/pkg',
    );
    assert.equal(overridden.ref, 'v1');
    assert.equal(overridden.repoRoot, '/custom');
  });

  it('SUPPORT_* переопределяют, хвостовой слэш базы срезается', () => {
    const config = loadSupportBotConfig(
      {
        SUPPORT_REPO: 'o/r',
        SUPPORT_TOKEN: 'tok',
        SUPPORT_API_URL: 'https://ghe.corp/api/v3/',
        SUPPORT_ISSUE_NUMBER: '42',
        SUPPORT_EVENT: 'issue_comment',
        SUPPORT_ACTOR: 'user1',
        SUPPORT_FAQ_DIR: '/faq',
        SUPPORT_CACHE_DIR: '/cache',
        SUPPORT_TOP_K_FAQ: '8',
        SUPPORT_NO_THINKING: '1',
      },
      '/pkg',
    );
    assert.deepEqual(config, {
      repo: 'o/r',
      token: 'tok',
      apiBaseUrl: 'https://ghe.corp/api/v3',
      issueNumber: 42,
      event: 'issue_comment',
      actor: 'user1',
      faqDir: '/faq',
      cacheDir: '/cache',
      topKFaq: 8,
      disableThinking: true,
      codeSearch: false,
      ref: 'main',
      repoRoot: '',
    });
  });

  it('SUPPORT_CODE_SEARCH=1 включает поиск по коду', () => {
    assert.equal(loadSupportBotConfig({ SUPPORT_CODE_SEARCH: '1' }, '/pkg').codeSearch, true);
    assert.equal(loadSupportBotConfig({ SUPPORT_CODE_SEARCH: '0' }, '/pkg').codeSearch, false);
    assert.equal(loadSupportBotConfig({}, '/pkg').codeSearch, false);
  });

  it('GITHUB_* как запасные; невалидный номер → 0; topK зажат сверху', () => {
    const config = loadSupportBotConfig(
      {
        GITHUB_REPOSITORY: 'g/r',
        GITHUB_TOKEN: 'ght',
        GITHUB_API_URL: 'https://api.github.com',
        SUPPORT_ISSUE_NUMBER: 'не число',
        SUPPORT_TOP_K_FAQ: '999',
      },
      '/pkg',
    );
    assert.equal(config.repo, 'g/r');
    assert.equal(config.token, 'ght');
    assert.equal(config.issueNumber, 0);
    assert.equal(config.topKFaq, 50);
  });

  it('GH_TOKEN как последний запасной токен', () => {
    assert.equal(loadSupportBotConfig({ GH_TOKEN: 'gh' }, '/pkg').token, 'gh');
  });
});
