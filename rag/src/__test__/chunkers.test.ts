import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chunkFixed, chunkStructural, chunkDocument } from '../index.ts';
import type { Document } from '../index.ts';

const doc = (file: string, text: string): Document => ({
  source: 'src',
  file,
  title: file.split('/').pop() ?? file,
  text,
});

describe('chunkFixed', () => {
  it('пустой/пробельный текст → нет чанков', () => {
    assert.deepEqual(chunkFixed(doc('a.txt', '   \n  '), { size: 10, overlap: 2 }), []);
  });

  it('режет с перекрытием, проставляет метаданные и chunk_id', () => {
    const chunks = chunkFixed(doc('a.txt', 'abcdefghij'), { size: 4, overlap: 1 });
    // step = 3: [0..4)=abcd, [3..7)=defg, [6..10)=ghij
    assert.deepEqual(
      chunks.map(c => c.text),
      ['abcd', 'defg', 'ghij'],
    );
    assert.equal(chunks[0].chunk_id, 'a.txt#0');
    assert.equal(chunks[0].section, 'фрагмент 1');
    assert.equal(chunks[0].file, 'a.txt');
  });

  it('пропускает полностью пробельные окна', () => {
    const chunks = chunkFixed(doc('a.txt', 'aa' + '\n'.repeat(8) + 'bb'), { size: 4, overlap: 0 });
    // окно из одних переводов строки отбрасывается; остаются куски с текстом
    assert.ok(chunks.every(c => c.text.trim() !== ''));
    assert.ok(chunks.length >= 2);
  });
});

describe('chunkStructural', () => {
  it('markdown: режет по заголовкам, section = заголовок; преамбула → title', () => {
    const text = 'вступление\n## Раздел A\nтекст A\n## Раздел B\nтекст B';
    const chunks = chunkStructural(doc('readme.md', text), 1000);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].section, 'readme.md'); // преамбула — раздел с именем title
    assert.equal(chunks[1].section, 'Раздел A');
    assert.match(chunks[1].text, /## Раздел A\nтекст A/);
    assert.equal(chunks[2].section, 'Раздел B');
  });

  it('markdown начинается с заголовка → без пустой преамбулы', () => {
    const chunks = chunkStructural(doc('r.md', '# Title\nтело'), 1000);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].section, 'Title');
  });

  it('markdown с пустым разделом (пробелы) → раздел пропускается', () => {
    const chunks = chunkStructural(doc('r.md', '\n\n## A\nсодержимое'), 1000);
    // преамбула из пустых строк отбрасывается, остаётся раздел A
    assert.deepEqual(
      chunks.map(c => c.section),
      ['A'],
    );
  });

  it('не-markdown (код) → файл целиком одним разделом (имя файла)', () => {
    const chunks = chunkStructural(doc('app.ts', 'const x = 1;\nconst y = 2;'), 1000);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].section, 'app.ts');
  });

  it('огромный раздел до-резается по длине, сохраняя section', () => {
    const big = 'x'.repeat(50);
    const chunks = chunkStructural(doc('big.ts', big), 20);
    assert.equal(chunks.length, 3); // 20+20+10
    assert.ok(chunks.every(c => c.section === 'big.ts'));
  });
});

describe('chunkDocument', () => {
  it('диспетчеризует по стратегии', () => {
    const d = doc('r.md', '## A\nтекст');
    const fixed = chunkDocument(d, 'fixed', {
      fixed: { size: 100, overlap: 0 },
      structuralMaxSize: 100,
    });
    const structural = chunkDocument(d, 'structural', {
      fixed: { size: 100, overlap: 0 },
      structuralMaxSize: 100,
    });
    assert.equal(fixed[0].section, 'фрагмент 1');
    assert.equal(structural[0].section, 'A');
  });
});
