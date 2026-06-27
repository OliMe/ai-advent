import { stdin, stdout } from 'node:process';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpToolSet, createConnection } from '../../mcp-client/src/index.ts';
import {
  main,
  reportFatalError,
  FileMcpStore,
  mcpConfigPath,
  runWatch,
  systemNotify,
  pollServerNames,
  loadVoiceConfig,
  transcribeWithYandex,
} from './index.ts';
import type { AudioRecorder, VoiceConfig, VoiceInput } from './index.ts';

/** Рекордер микрофона на ffmpeg (avfoundation): пишет OggOpus во временный файл, стоп — «q». */
function ffmpegRecorder(device: string): AudioRecorder {
  return {
    start() {
      const file = join(mkdtempSync(join(tmpdir(), 'llm-voice-')), 'audio.ogg');
      const child = spawn(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'avfoundation',
          '-i',
          device,
          '-ac',
          '1',
          '-ar',
          '48000',
          '-c:a',
          'libopus',
          '-y',
          file,
        ],
        { stdio: ['pipe', 'ignore', 'inherit'] },
      );
      return {
        finish: () =>
          new Promise<Uint8Array>((resolve, reject) => {
            child.on('error', reject);
            child.on('close', () => {
              try {
                const bytes = new Uint8Array(readFileSync(file));
                rmSync(file, { force: true });
                resolve(bytes);
              } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
              }
            });
            child.stdin.write('q'); // ffmpeg штатно завершает запись по «q» в stdin
            child.stdin.end();
          }),
      };
    },
  };
}

/** Собирает голосовой ввод из окружения: креды есть и вывод — терминал → запись+распознавание. */
function makeVoice(env: NodeJS.ProcessEnv): VoiceInput | null {
  const config: VoiceConfig | null = loadVoiceConfig(env);
  if (config === null || !stdout.isTTY) {
    return null;
  }
  const device = env.VOICE_INPUT_DEVICE?.trim() || ':0';
  return {
    recorder: ffmpegRecorder(device),
    transcribe: audio => transcribeWithYandex(globalThis.fetch as never, config, audio, 30_000),
  };
}

/** Фоновый режим (`--watch`): опрашивает планировщик и шлёт системные уведомления о новом. */
async function watchMode(): Promise<void> {
  const toolSet = new McpToolSet(createConnection);
  const store = new FileMcpStore(mcpConfigPath());
  for (const [name, config] of store.load()) {
    try {
      await toolSet.addServer(name, config);
    } catch {
      // недоступный сервер пропускаем
    }
  }
  // Наблюдателю нужен только планировщик (poll_results) — лишние подключения (OCR/ФС) закрываем,
  // чтобы не держать простаивающие HTTP-сессии и не множить точки отказа.
  const keep = new Set(pollServerNames(toolSet));
  for (const name of toolSet.serverNames()) {
    if (!keep.has(name)) {
      await toolSet.removeServer(name);
    }
  }
  if (keep.size === 0) {
    stdout.write('⚠ Не найден сервер с poll_results — нечего наблюдать. Проверьте mcp.json.\n');
  }
  let running = true;
  process.on('SIGINT', () => {
    running = false;
  });
  stdout.write('👀 Наблюдаю за планировщиком (Ctrl+C — выход)…\n');
  await runWatch({
    toolSet,
    output: stdout,
    notify: systemNotify,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    intervalMs: 30_000,
    shouldContinue: () => running,
  });
  await toolSet.close();
}

if (process.argv.includes('--watch')) {
  watchMode().catch(reportFatalError);
} else {
  main(process.argv, stdin, stdout, makeVoice).catch(reportFatalError);
}
