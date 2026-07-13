import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeGitIo, commandErrorOutput } from '../index.ts';

describe('nodeGitIo (настоящий репозиторий)', () => {
  it('запускает git, читает файлы и различает типы путей', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitmcp-'));
    try {
      nodeGitIo.run(['init', '-b', 'main'], root);
      writeFileSync(join(root, 'README.md'), '# демо\n');
      mkdirSync(join(root, 'src'));
      nodeGitIo.run(['add', 'README.md'], root);
      // Автор задаётся флагами -c: глобальный git-конфиг машины в тесте не используем.
      const committed = nodeGitIo.run(
        ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'первый'],
        root,
      );
      assert.ok(committed.ok);

      const branch = nodeGitIo.run(['rev-parse', '--abbrev-ref', 'HEAD'], root);
      assert.ok(branch.ok);
      assert.equal(branch.output.trim(), 'main');

      writeFileSync(join(root, 'README.md'), '# демо\nправка\n');
      const status = nodeGitIo.run(['status', '--short'], root);
      assert.match(status.output, /README\.md/);

      assert.equal(nodeGitIo.readText(join(root, 'README.md')), '# демо\nправка\n');
      assert.equal(nodeGitIo.stat(join(root, 'README.md')), 'file');
      assert.equal(nodeGitIo.stat(join(root, 'src')), 'dir');
      assert.equal(nodeGitIo.stat(join(root, 'нет.txt')), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ненулевой код возврата — ok: false с текстом ошибки, без исключения', () => {
    const outside = mkdtempSync(join(tmpdir(), 'gitmcp-plain-'));
    try {
      const result = nodeGitIo.run(['rev-parse', '--show-toplevel'], outside);
      assert.equal(result.ok, false);
      // Текст git локализован (у пользователя может быть русский), поэтому проверяем только
      // уровень сообщения — сам факт диагностики в выводе.
      assert.match(result.output, /fatal/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('commandErrorOutput', () => {
  it('берёт stderr, когда он непустой', () => {
    assert.equal(commandErrorOutput({ stderr: 'fatal: сбой\n', message: 'x' }), 'fatal: сбой\n');
  });

  it('пустой stderr — берёт message', () => {
    assert.equal(commandErrorOutput({ stderr: '  ', message: 'git не найден' }), 'git не найден');
  });

  it('без stderr и message — строковое представление', () => {
    assert.equal(commandErrorOutput('сломалось'), 'сломалось');
  });
});
