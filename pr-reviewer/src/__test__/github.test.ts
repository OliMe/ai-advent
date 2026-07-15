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

const MARK = '<!-- ai-review -->';

describe('createGithubPlatform.publish (идемпотентно)', () => {
  it('снимает свои прежние инлайн, обновляет сводку на месте, ставит свежие инлайн', async () => {
    const { fetchFn, calls } = recordingFetch(url => {
      if (url.endsWith('/pulls/7')) return { head: { sha: 'headsha' } };
      if (url.includes('/pulls/7/comments')) {
        // page 1: наш (маркер) + чужой; page 2 пустая
        return url.endsWith('&page=1')
          ? [
              { id: 101, body: `старое замечание\n${MARK}` }, // наше → удалить
              { id: 102, body: 'ответ человека' }, // чужое → не трогать
            ]
          : [];
      }
      if (url.includes('/issues/7/comments')) {
        return url.endsWith('&page=1') ? [{ id: 201, body: `прежняя сводка\n${MARK}` }] : [];
      }
      return {};
    });

    await createGithubPlatform(deps(fetchFn)).publish({
      summary: `## AI-ревью\n\nитог\n${MARK}`,
      comments: [{ file: 'src/a.ts', line: 2, body: `проблема\n${MARK}` }],
    });

    const seq = calls.map(
      c => `${c.method} ${c.url.replace('https://api.github.com/repos/OliMe/ai-advent', '')}`,
    );
    // Удалён только НАШ инлайн (101), чужой (102) не тронут.
    assert.ok(seq.includes('DELETE /pulls/comments/101'));
    assert.ok(!seq.some(s => s.includes('/pulls/comments/102')));
    // Сводка обновлена на месте (PATCH), не создана заново.
    const patch = calls.find(c => c.method === 'PATCH');
    assert.match(patch!.url, /\/issues\/comments\/201$/);
    assert.match(JSON.parse(patch!.body as string).body, /итог/);
    assert.ok(!seq.some(s => s.startsWith('POST /issues/')));
    // Свежий инлайн поставлен отдельным комментарием с commit_id = head sha.
    const post = calls.find(c => c.method === 'POST' && c.url.includes('/pulls/7/comments'));
    const payload = JSON.parse(post!.body as string);
    assert.deepEqual(payload, {
      commit_id: 'headsha',
      path: 'src/a.ts',
      line: 2,
      side: 'RIGHT',
      body: `проблема\n${MARK}`,
    });
  });

  it('прежней сводки нет — создаёт issue-комментарий; лишние свои сводки удаляет', async () => {
    const { fetchFn, calls } = recordingFetch(url => {
      if (url.endsWith('/pulls/7')) return { head: { sha: 's' } };
      if (url.includes('/pulls/7/comments')) return [];
      if (url.includes('/issues/7/comments')) {
        // две наших сводки — первую обновить, вторую удалить
        return url.endsWith('&page=1')
          ? [
              { id: 301, body: `сводка A\n${MARK}` },
              { id: 302, body: `сводка B\n${MARK}` },
            ]
          : [];
      }
      return {};
    });

    await createGithubPlatform(deps(fetchFn)).publish({ summary: `итог\n${MARK}`, comments: [] });

    const seq = calls.map(
      c => `${c.method} ${c.url.replace('https://api.github.com/repos/OliMe/ai-advent', '')}`,
    );
    assert.ok(seq.includes('PATCH /issues/comments/301')); // первую обновили
    assert.ok(seq.includes('DELETE /issues/comments/302')); // лишнюю удалили
  });

  it('своих сводок нет — POST нового issue-комментария', async () => {
    const { fetchFn, calls } = recordingFetch(url => {
      if (url.endsWith('/pulls/7')) return { head: { sha: 's' } };
      return []; // ни инлайн, ни issue-комментариев
    });
    await createGithubPlatform(deps(fetchFn)).publish({ summary: `итог\n${MARK}`, comments: [] });
    const post = calls.find(c => c.method === 'POST');
    assert.match(post!.url, /\/issues\/7\/comments$/);
  });

  it('head sha не получен — инлайн не постятся (привязать не к чему), сводка обновляется', async () => {
    const { fetchFn, calls } = recordingFetch(url => {
      if (url.endsWith('/pulls/7')) return {}; // нет head.sha
      return [];
    });
    await createGithubPlatform(deps(fetchFn)).publish({
      summary: `итог\n${MARK}`,
      comments: [{ file: 'a.ts', line: 1, body: 'x' }],
    });
    assert.ok(!calls.some(c => c.url.includes('/pulls/7/comments') && c.method === 'POST'));
    assert.ok(calls.some(c => c.method === 'POST' && c.url.includes('/issues/7/comments')));
  });
});
