/**
 * Реальные node-биндинги рабочего пространства прогона (тонкая проводка, вне покрытия): файловый IO
 * поверх node:fs и запуск команд поверх child_process. Логика — в run-workspace.ts (тестируется с
 * фейками этих швов).
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  readdirSync,
  rmSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import type { ProjectCommandRunner, CommandResult, CommandRunOptions } from '../../core/src/index.ts';
import type { WorkspaceIo } from './run-workspace.ts';

/** Файловый IO пространства поверх node:fs. */
export const nodeWorkspaceIo: WorkspaceIo = {
  readFile: path => readFileSync(path, 'utf8'),
  writeFile: (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  },
  exists: path => existsSync(path),
  isDirectory: path => existsSync(path) && statSync(path).isDirectory(),
  listDir: path => readdirSync(path),
  deleteFile: path => {
    if (existsSync(path)) {
      rmSync(path);
    }
  },
  copyFile: (source, destination) => {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  },
  symlink: (target, linkPath) => symlinkSync(target, linkPath, 'dir'),
  makeTempDir: prefix => mkdtempSync(join(tmpdir(), prefix)),
  removeDir: path => rmSync(path, { recursive: true, force: true }),
};

/** Потолок времени команды по умолчанию (мс), если вызывающий не задал свой. */
const DEFAULT_COMMAND_TIMEOUT_MS = 300000;

/** Запуск команды проекта поверх child_process (shell; таймаут; захват потоков и кода). */
export const nodeCommandRunner: ProjectCommandRunner = {
  run: (command: string, options: CommandRunOptions): Promise<CommandResult> =>
    new Promise(resolve => {
      // Переменные проекта (.env/.env.development) — поверх process.env: команды сборки/тестов
      // видят требуемые переменные. node_modules/.bin в PATH — иначе «голые» бинарники скриптов
      // (напр. `jest`) не находятся (127); .bin резолвится через симлинк node_modules в копии.
      const binDir = join(options.cwd, 'node_modules', '.bin');
      const baseEnv = { ...process.env, ...options.env };
      const child = spawn(command, {
        cwd: options.cwd,
        shell: true,
        env: { ...baseEnv, PATH: `${binDir}${delimiter}${baseEnv.PATH ?? ''}` },
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout.on('data', chunk => (stdout += chunk.toString()));
      child.stderr.on('data', chunk => (stderr += chunk.toString()));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
      child.on('error', error => {
        clearTimeout(timer);
        resolve({ command, code: 1, stdout, stderr: `${stderr}${String(error)}`, timedOut });
      });
      child.on('close', code => {
        clearTimeout(timer);
        resolve({ command, code: code ?? 1, stdout, stderr, timedOut });
      });
    }),
};
