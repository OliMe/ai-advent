import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDocLanguage,
  detectLanguageByScript,
  parseLanguageReply,
  pickProseSamples,
} from '../index.ts';
import type { IndexedChunk } from '../../../rag/src/index.ts';

const chunk = (file: string, text: string): IndexedChunk => ({
  chunk_id: `${file}#0`,
  source: 'src',
  file,
  title: file,
  section: file,
  text,
  embedding: [],
});

describe('parseLanguageReply', () => {
  it('берёт первое слово, чистит пунктуацию/кавычки', () => {
    assert.equal(parseLanguageReply('  English.  '), 'English');
    assert.equal(parseLanguageReply('«Russian»'), 'Russian');
    assert.equal(parseLanguageReply('German (Deutsch)'), 'German'); // только первое слово
  });
  it('нераспознанный/пустой → пустая строка', () => {
    assert.equal(parseLanguageReply('   '), '');
    assert.equal(parseLanguageReply('42!'), '');
  });
});

describe('detectLanguageByScript', () => {
  it('преобладает кириллица → Russian; латиница → English', () => {
    assert.equal(detectLanguageByScript(['Это документация на русском языке']), 'Russian');
    assert.equal(detectLanguageByScript(['This is English documentation']), 'English');
  });
  it('пусто/без букв → English (нет кириллического перевеса)', () => {
    assert.equal(detectLanguageByScript([]), 'English');
    assert.equal(detectLanguageByScript(['1234 !!! ---']), 'English');
  });
});

describe('pickProseSamples', () => {
  it('предпочитает прозу (.md/README) над кодом', () => {
    const chunks = [
      chunk('main.go', 'package main func foo()'),
      chunk('README.md', 'Описание проекта на русском'),
      chunk('docs/guide.md', 'Руководство'),
    ];
    assert.deepEqual(pickProseSamples(chunks), ['Описание проекта на русском', 'Руководство']);
  });
  it('нет прозы → берём что есть; пусто → []', () => {
    assert.deepEqual(pickProseSamples([chunk('a.go', 'code')]), ['code']);
    assert.deepEqual(pickProseSamples([]), []);
  });
  it('режет по limit и perChunk', () => {
    const many = Array.from({ length: 20 }, (_, i) => chunk(`f${i}.md`, 'x'.repeat(600)));
    const out = pickProseSamples(many, 3, 100);
    assert.equal(out.length, 3);
    assert.equal(out[0].length, 100);
  });
});

describe('resolveDocLanguage', () => {
  const ruProse = [chunk('README.md', 'Документация на русском языке про инструмент')];
  const enProse = [chunk('README.md', 'Documentation about the tool in English')];

  it('оверрайд имеет высший приоритет', async () => {
    const r = await resolveDocLanguage({
      override: 'German',
      cachedLanguage: 'English',
      chunks: [],
    });
    assert.deepEqual(r, { language: 'German', source: 'override' });
  });

  it('кэш индекса — без вызова модели', async () => {
    const r = await resolveDocLanguage({
      cachedLanguage: 'French',
      chunks: enProse,
      chatComplete: async () => 'English',
    });
    assert.deepEqual(r, { language: 'French', source: 'cache' });
  });

  it('LLM-детект: модель называет язык', async () => {
    const r = await resolveDocLanguage({
      chunks: enProse,
      chatComplete: async () => 'English',
    });
    assert.deepEqual(r, { language: 'English', source: 'model' });
  });

  it('пустой ответ модели → откат на письменность', async () => {
    const r = await resolveDocLanguage({ chunks: ruProse, chatComplete: async () => '   ' });
    assert.deepEqual(r, { language: 'Russian', source: 'script' });
  });

  it('сбой модели → откат на письменность', async () => {
    const r = await resolveDocLanguage({
      chunks: ruProse,
      chatComplete: async () => {
        throw new Error('нет сети');
      },
    });
    assert.deepEqual(r, { language: 'Russian', source: 'script' });
  });

  it('без модели → сразу письменность', async () => {
    assert.deepEqual(await resolveDocLanguage({ chunks: enProse }), {
      language: 'English',
      source: 'script',
    });
  });

  it('модель есть, но чанков нет (выборка пуста) → письменность, модель не зовётся', async () => {
    let called = false;
    const r = await resolveDocLanguage({
      chunks: [],
      chatComplete: async () => {
        called = true;
        return 'English';
      },
    });
    assert.deepEqual(r, { language: 'English', source: 'script' });
    assert.equal(called, false);
  });
});
