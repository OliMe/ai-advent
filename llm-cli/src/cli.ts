import { stdin, stdout } from 'node:process';
import { McpToolSet, createConnection } from '../../mcp-client/src/index.ts';
import {
  main,
  reportFatalError,
  FileMcpStore,
  mcpConfigPath,
  runWatch,
  systemNotify,
} from './index.ts';

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
  main(process.argv, stdin, stdout).catch(reportFatalError);
}
