import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTextFile,
  loadLocalDocuments,
  htmlToText,
  extractTitle,
  extractLinks,
  crawlWeb,
  isGithubUrl,
  githubTarballUrl,
  detectSource,
  loadDocuments,
} from '../index.ts';
import type { Document, LocalIo, SourceLoaders } from '../index.ts';

describe('local source', () => {
  it('isTextFile: код/доки — да, бинарь/без расширения — нет', () => {
    assert.equal(isTextFile('a.md'), true);
    assert.equal(isTextFile('app.ts'), true);
    assert.equal(isTextFile('img.png'), false);
    assert.equal(isTextFile('Makefile'), false);
  });

  it('loadLocalDocuments: фильтрует по типу/размеру, строит метаданные', () => {
    const files: Record<string, string> = {
      '/r/a.md': 'привет',
      '/r/sub/b.ts': 'код',
      '/r/img.png': 'бинарь',
      '/r/empty.txt': '   ',
      '/r/big.txt': 'x'.repeat(2000),
    };
    const io: LocalIo = { listFiles: () => Object.keys(files), readText: p => files[p] };
    const docs = loadLocalDocuments('/r', io, 1000);
    assert.deepEqual(
      docs.map(d => d.file).sort(),
      ['a.md', 'sub/b.ts'], // png — не текст, empty — пусто, big — больше maxBytes
    );
    assert.equal(docs.find(d => d.file === 'sub/b.ts')?.title, 'b.ts');
  });

  it('maxBytes по умолчанию допускает крупный файл; путь==корень → basename', () => {
    const big: Record<string, string> = { '/r/big.txt': 'x'.repeat(2000) };
    assert.equal(
      loadLocalDocuments('/r', { listFiles: () => Object.keys(big), readText: p => big[p] }).length,
      1,
    );
    // корень — это сам файл: relative('') → basename
    const single: Record<string, string> = { '/r/a.md': 'текст' };
    const docs = loadLocalDocuments('/r/a.md', {
      listFiles: () => Object.keys(single),
      readText: p => single[p],
    });
    assert.equal(docs[0].file, 'a.md');
  });
});

describe('web source', () => {
  it('htmlToText: убирает script/style и теги, раскрывает сущности', () => {
    const text = htmlToText(
      '<script>alert(1)</script><style>.c{color:red}</style><h1>Заголовок</h1><p>Текст&nbsp;тут &amp; всё</p>',
    );
    assert.match(text, /Заголовок/);
    assert.match(text, /Текст тут & всё/);
    assert.doesNotMatch(text, /alert/);
    assert.doesNotMatch(text, /color/);
  });

  it('extractTitle: из <title> или пусто', () => {
    assert.equal(extractTitle('<title> Привет </title>'), 'Привет');
    assert.equal(extractTitle('<p>без заголовка</p>'), '');
  });

  it('extractLinks: только тот же origin, абсолютные; битые и чужие — отброшены', () => {
    const html =
      '<a href="/page">a</a><a href="https://other.com/x">b</a><a href="http://[bad">c</a>';
    assert.deepEqual(extractLinks(html, 'https://site.com/'), ['https://site.com/page']);
  });

  it('crawlWeb: обход до глубины, дедуп общего потомка, пропуск null/чужих/самоссылок', async () => {
    // a и b ссылаются на общий /c → во фронтире он дважды, второй раз отсеётся как посещённый.
    const pages: Record<string, string> = {
      'https://s.com/':
        '<title>Home</title><a href="/a">A</a><a href="/b">B</a><a href="https://ext.com/x">e</a><a href="/">self</a>',
      'https://s.com/a': '<a href="/c">C</a><a href="/missing">m</a>',
      'https://s.com/b': '<a href="/c">C</a>',
      'https://s.com/c': 'тело C', // без title → заголовок=URL
    };
    const docs = await crawlWeb('https://s.com/', 2, async url => pages[url] ?? null);
    assert.deepEqual(docs.map(d => d.file).sort(), [
      'https://s.com/',
      'https://s.com/a',
      'https://s.com/b',
      'https://s.com/c', // один раз, несмотря на две ссылки; /missing → null; ext — чужой
    ]);
    assert.equal(docs.find(d => d.file === 'https://s.com/c')?.title, 'https://s.com/c');
  });
});

describe('github source', () => {
  it('isGithubUrl', () => {
    assert.equal(isGithubUrl('https://github.com/o/r'), true);
    assert.equal(isGithubUrl('https://gitlab.com/o/r'), false);
    assert.equal(isGithubUrl('не url'), false);
  });

  it('githubTarballUrl: codeload, ветка HEAD/заданная, .git срезается', () => {
    assert.equal(
      githubTarballUrl('https://github.com/owner/repo'),
      'https://codeload.github.com/owner/repo/tar.gz/HEAD',
    );
    assert.equal(
      githubTarballUrl('https://github.com/o/r.git', 'main'),
      'https://codeload.github.com/o/r/tar.gz/main',
    );
  });

  it('githubTarballUrl: не github / мало частей → ошибка', () => {
    assert.throws(() => githubTarballUrl('https://gitlab.com/o/r'), /GitHub/);
    assert.throws(() => githubTarballUrl('https://github.com/owner'), /GitHub/);
  });
});

describe('resolve source', () => {
  it('detectSource: github / web / local', () => {
    assert.equal(detectSource('https://github.com/o/r'), 'github');
    assert.equal(detectSource('https://react.dev/reference'), 'web');
    assert.equal(detectSource('./docs'), 'local');
  });

  it('loadDocuments: диспетчеризует по типу источника', async () => {
    const called: string[] = [];
    const make =
      (kind: string): ((input: string) => Promise<Document[]>) =>
      async () => {
        called.push(kind);
        return [];
      };
    const loaders: SourceLoaders = {
      local: make('local'),
      github: make('github'),
      web: make('web'),
    };
    await loadDocuments('https://github.com/o/r', loaders);
    await loadDocuments('https://react.dev', loaders);
    await loadDocuments('/some/path', loaders);
    assert.deepEqual(called, ['github', 'web', 'local']);
  });
});
