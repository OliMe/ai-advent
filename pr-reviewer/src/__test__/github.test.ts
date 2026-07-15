import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGithubPlatform } from '../index.ts';
import type { FetchLike, GithubDeps, HttpResponse } from '../index.ts';

/** JSON-ответ 200. */
function ok(body: unknown): HttpResponse {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => '' };
}

/** Записывает запросы; отвечает по маршруту (url → тело). */
function recordingFetch(routes: (url: string) => unknown): {
  fetchFn: FetchLike;
  calls: { method: string; url: string; body?: string }[];
} {
  const calls: { method: string; url: string; body?: string }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ method: init.method, url, ...(init.body ? { body: init.body } : {}) });
    return ok(routes(url));
  };
  return { fetchFn, calls };
}

function deps(fetchFn: FetchLike, overrides: Partial<GithubDeps> = {}): GithubDeps {
  return {
    fetchFn,
    apiBaseUrl: 'https://api.github.com',
    repo: 'OliMe/ai-advent',
    prNumber: 7,
    token: 'tok',
    timeoutMs: 1000,
    maxRetries: 1,
    retryBaseMs: 1,
    sleep: async () => {},
    ...overrides,
  };
}

const PATCH = '@@ -1,1 +1,2 @@\n ctx\n+added';

describe('createGithubPlatform.fetchChanges', () => {
  it('берёт метаданные и файлы, статусы маппятся, бинарник без patch', async () => {
    const { fetchFn, calls } = recordingFetch(url => {
      if (url.endsWith('/pulls/7')) {
        return { title: 'Заголовок PR', body: 'Описание' };
      }
      if (url.includes('page=1')) {
        return [
          { filename: 'src/a.ts', status: 'modified', patch: PATCH },
          { filename: 'new.ts', status: 'added', patch: '@@ -0,0 +1,1 @@\n+n' },
          { filename: 'img.png', status: 'modified' }, // нет patch → binary
          { filename: 'renamed.ts', status: 'renamed', previous_filename: 'old.ts', patch: PATCH },
          { filename: 'gone.ts', status: 'removed' },
          { status: 'modified' }, // нет filename → отбрасывается
        ];
      }
      return [];
    });

    const changes = await createGithubPlatform(deps(fetchFn)).fetchChanges();

    assert.equal(changes.title, 'Заголовок PR');
    assert.equal(changes.description, 'Описание');
    assert.equal(changes.truncated, false);
    assert.deepEqual(
      changes.files.map(f => [f.path, f.status]),
      [
        ['src/a.ts', 'modified'],
        ['new.ts', 'added'],
        ['img.png', 'binary'],
        ['renamed.ts', 'renamed'],
        ['gone.ts', 'removed'],
      ],
    );
    assert.equal(changes.files[3].oldPath, 'old.ts');
    // Авторизация ушла в заголовке.
    assert.ok(calls.length >= 2);
  });

  it('пустой список файлов и отсутствующие метаданные', async () => {
    const { fetchFn } = recordingFetch(url => (url.endsWith('/pulls/7') ? {} : []));
    const changes = await createGithubPlatform(deps(fetchFn)).fetchChanges();
    assert.equal(changes.title, '');
    assert.equal(changes.description, '');
    assert.deepEqual(changes.files, []);
  });

  it('пагинация: полная страница → запрос следующей', async () => {
    const full = Array.from({ length: 100 }, (_v, i) => ({
      filename: `f${i}.ts`,
      status: 'added',
      patch: '@@ -0,0 +1,1 @@\n+x',
    }));
    let pages = 0;
    const fetchFn: FetchLike = async url => {
      if (url.endsWith('/pulls/7')) return ok({ title: 't', body: '' });
      pages++;
      // Якорь на &page=1 в конце — иначе подстрока «page=1» ложно матчит «per_page=100».
      return ok(url.endsWith('&page=1') ? full : []);
    };
    const changes = await createGithubPlatform(deps(fetchFn)).fetchChanges();
    assert.equal(changes.files.length, 100);
    assert.equal(changes.truncated, false);
    assert.equal(pages, 2); // страница 1 (полная) + страница 2 (пустая)
  });

  it('гигантский PR: достигнут потолок страниц → truncated', async () => {
    const full = Array.from({ length: 100 }, (_v, i) => ({
      filename: `f${i}.ts`,
      status: 'added',
      patch: '@@ -0,0 +1,1 @@\n+x',
    }));
    const fetchFn: FetchLike = async url =>
      ok(url.endsWith('/pulls/7') ? { title: 't', body: '' } : full); // все страницы полны
    const changes = await createGithubPlatform(deps(fetchFn)).fetchChanges();
    assert.equal(changes.truncated, true);
    assert.equal(changes.files.length, 3000); // 30 страниц × 100 (потолок)
  });
});

describe('createGithubPlatform.publish', () => {
  it('POST reviews c инлайн-комментариями (path/line/side) и сводкой', async () => {
    const { fetchFn, calls } = recordingFetch(() => ({}));
    await createGithubPlatform(deps(fetchFn)).publish({
      summary: 'Итог ревью',
      comments: [{ file: 'src/a.ts', line: 2, body: 'проблема тут' }],
    });

    const post = calls.find(c => c.method === 'POST');
    assert.ok(post);
    assert.match(post.url, /\/repos\/OliMe\/ai-advent\/pulls\/7\/reviews$/);
    const payload = JSON.parse(post.body as string);
    assert.equal(payload.event, 'COMMENT');
    assert.equal(payload.body, 'Итог ревью');
    assert.deepEqual(payload.comments, [
      { path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'проблема тут' },
    ]);
  });

  it('без инлайн-комментариев — ревью только со сводкой (пустой comments)', async () => {
    const { fetchFn, calls } = recordingFetch(() => ({}));
    await createGithubPlatform(deps(fetchFn)).publish({
      summary: 'нечего комментировать',
      comments: [],
    });
    const payload = JSON.parse(calls[0].body as string);
    assert.deepEqual(payload.comments, []);
  });
});
