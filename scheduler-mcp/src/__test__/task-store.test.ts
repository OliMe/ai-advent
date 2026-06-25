import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { FileTaskStore } from '../index.ts';
import type { SchedulerState } from '../index.ts';

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sched-store-'));
  return join(dir, 'state.json');
}

const sampleState: SchedulerState = {
  tasks: [
    {
      id: 't1',
      title: 'тест',
      kind: 'note',
      text: 'привет',
      schedule: { type: 'interval', everySeconds: 10 },
      status: 'active',
      createdAt: '2026-06-25T00:00:00.000Z',
      nextFireAt: '2026-06-25T00:00:10.000Z',
    },
  ],
  runs: [],
};

describe('FileTaskStore', () => {
  it('отсутствующий файл → пустое состояние', () => {
    const store = new FileTaskStore(tempPath());
    assert.deepEqual(store.read(), { tasks: [], runs: [] });
  });

  it('запись и чтение — круговой рейс', () => {
    const path = tempPath();
    const store = new FileTaskStore(path);
    store.write(sampleState);
    assert.deepEqual(store.read(), sampleState);
  });

  it('битый JSON → пустое состояние', () => {
    const path = tempPath();
    writeFileSync(path, '{не json');
    assert.deepEqual(new FileTaskStore(path).read(), { tasks: [], runs: [] });
  });

  it('валидный JSON, но не состояние → пустое состояние', () => {
    const path = tempPath();
    writeFileSync(path, JSON.stringify({ tasks: 1, runs: [] }));
    assert.deepEqual(new FileTaskStore(path).read(), { tasks: [], runs: [] });
  });

  it('JSON null → пустое состояние', () => {
    const path = tempPath();
    writeFileSync(path, 'null');
    assert.deepEqual(new FileTaskStore(path).read(), { tasks: [], runs: [] });
    rmSync(path, { force: true });
  });
});
