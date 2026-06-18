import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline, createRun, Conversation } from '../index.ts';
import type {
  CompletionArtifact,
  GenerationLimits,
  PipelineHooks,
  RunStore,
  RunSummary,
  Stage,
  TaskRun,
} from '../index.ts';
import { clientWith } from './helpers.ts';

/** Канон контента по этапам; значения — функции (для смены ответа между ретраями). */
type StageContent = Record<Stage, () => string>;

function stageOf(systemPrompt: string): Stage {
  if (systemPrompt.includes('планировщик')) return 'planning';
  if (systemPrompt.includes('исполнитель')) return 'execution';
  if (systemPrompt.includes('проверяющий')) return 'verification';
  return 'completion';
}

function makeConversation(t: TestContext, content: StageContent) {
  return (systemPrompt: string, limits?: GenerationLimits) => {
    const client = clientWith(t, async () => ({
      content: content[stageOf(systemPrompt)](),
      usage: undefined,
    }));
    return new Conversation(client, {
      systemPrompt,
      temperature: 0.5,
      contextTokens: 8192,
      requestTimeoutMs: 5000,
      limits,
    });
  };
}

/** Хранилище-заглушка: снимок прогона на каждом save + список записанных артефактов. */
function fakeStore(): RunStore & { saved: TaskRun[]; artifacts: string[] } {
  const saved: TaskRun[] = [];
  const artifacts: string[] = [];
  return {
    saved,
    artifacts,
    list: (): RunSummary[] => [],
    load: () => null,
    save: run => saved.push(structuredClone(run)),
    delete: () => {},
    writeArtifact: (runId, name) => {
      artifacts.push(name);
      return `/runs/${runId}/${name}`;
    },
  };
}

const PLAN = JSON.stringify({ steps: ['шаг'], criteria: ['критерий'], text: 'план' });
const EXEC = JSON.stringify({ summary: 'готово', log: ['l'], text: 'результат' });
const PASS = JSON.stringify({ passed: true, issues: [], text: 'ок' });
const FAIL = JSON.stringify({ passed: false, issues: ['нет тестов'], text: 'плохо' });
const DONE = JSON.stringify({ summary: 'итог', text: 'резюме' });

const idle = new AbortController().signal; // не отменён

function content(over: Partial<StageContent> = {}): StageContent {
  return {
    planning: () => PLAN,
    execution: () => EXEC,
    verification: () => PASS,
    completion: () => DONE,
    ...over,
  };
}

const approve: PipelineHooks = { confirmCompletion: async () => ({ approved: true }) };

describe('runPipeline', () => {
  it('happy path: проходит все этапы и завершается с подтверждением', async t => {
    const run = createRun('Задача', { idSuffix: 'a' });
    const store = fakeStore();
    const stages: Stage[] = [];
    const hooks: PipelineHooks = {
      confirmCompletion: async () => ({ approved: true }),
      onStageStart: stage => stages.push(stage),
      onArtifact: () => {},
      onRetry: () => {},
    };

    const result = await runPipeline(run, {
      store,
      makeConversation: makeConversation(t, content()),
      signal: idle,
      hooks,
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(result.artifacts.planning?.steps, ['шаг']);
    assert.deepEqual(result.artifacts.execution?.files, ['/runs/' + run.id + '/execution-1.md']);
    assert.equal(result.artifacts.verification?.passed, true);
    assert.equal(result.artifacts.completion?.summary, 'итог');
    assert.deepEqual(stages, ['planning', 'execution', 'verification', 'completion']);
    assert.equal(store.artifacts.length, 1); // один файл execution
    assert.ok(store.saved.length >= 4);
  });

  it('провал проверки → авто-возврат в execution, затем успех', async t => {
    const run = createRun('Задача', { idSuffix: 'b', maxRetries: 2 });
    let verifyCalls = 0;
    const retries: number[] = [];
    const result = await runPipeline(run, {
      store: fakeStore(),
      makeConversation: makeConversation(
        t,
        content({
          verification: () => (++verifyCalls === 1 ? FAIL : PASS),
        }),
      ),
      signal: idle,
      hooks: { confirmCompletion: async () => ({ approved: true }), onRetry: n => retries.push(n) },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.retries, 1);
    assert.deepEqual(retries, [1]);
  });

  it('провал проверки исчерпал ретраи → пауза', async t => {
    const run = createRun('Задача', { idSuffix: 'c', maxRetries: 1 });
    const result = await runPipeline(run, {
      store: fakeStore(),
      makeConversation: makeConversation(t, content({ verification: () => FAIL })),
      signal: idle,
      hooks: approve,
    });
    assert.equal(result.status, 'paused');
    assert.equal(result.stage, 'verification');
    assert.equal(result.retries, 1);
  });

  it('отказ на завершении → возврат в execution, затем подтверждение', async t => {
    const run = createRun('Задача', { idSuffix: 'd', maxRetries: 2 });
    let confirmCalls = 0;
    const retries: Array<'verification' | 'rejection'> = [];
    const result = await runPipeline(run, {
      store: fakeStore(),
      makeConversation: makeConversation(t, content()),
      signal: idle,
      hooks: {
        confirmCompletion: async () =>
          ++confirmCalls === 1 ? { approved: false, feedback: 'доделай' } : { approved: true },
        onRetry: (_attempt, reason) => retries.push(reason),
      },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.retries, 1);
    assert.deepEqual(retries, ['rejection']); // возврат произошёл из-за отказа
    assert.equal(result.correction, undefined); // правка учтена и сброшена
  });

  it('отказ на завершении исчерпал ретраи → пауза', async t => {
    const run = createRun('Задача', { idSuffix: 'e', maxRetries: 0 });
    const result = await runPipeline(run, {
      store: fakeStore(),
      makeConversation: makeConversation(t, content()),
      signal: idle,
      hooks: { confirmCompletion: async () => ({ approved: false, feedback: 'нет' }) },
    });
    assert.equal(result.status, 'paused');
    assert.equal(result.stage, 'completion');
  });

  it('отменённый signal → пауза на границе этапа, без вызова подтверждения', async t => {
    const run = createRun('Задача', { idSuffix: 'f' });
    const aborted = new AbortController();
    aborted.abort();
    let confirmCalled = false;
    const result = await runPipeline(run, {
      store: fakeStore(),
      makeConversation: makeConversation(t, content()),
      signal: aborted.signal,
      hooks: {
        confirmCompletion: async () => {
          confirmCalled = true;
          return { approved: true };
        },
      },
    });
    assert.equal(result.status, 'paused');
    assert.equal(result.stage, 'planning');
    assert.equal(confirmCalled, false);
  });

  it('продолжение приостановленного прогона доводит до завершения', async t => {
    const run = { ...createRun('Задача', { idSuffix: 'g' }), status: 'paused' as const };
    const result = await runPipeline(run, {
      store: fakeStore(),
      makeConversation: makeConversation(t, content()),
      signal: idle,
      hooks: approve,
    });
    assert.equal(result.status, 'completed');
  });

  it('завершённый/отменённый прогон — no-op', async t => {
    const completed = { ...createRun('A', { idSuffix: 'h' }), status: 'completed' as const };
    let called = false;
    const make = () => {
      called = true;
      return null as never;
    };
    const r1 = await runPipeline(completed, {
      store: fakeStore(),
      makeConversation: make,
      signal: idle,
      hooks: approve,
    });
    assert.equal(r1.status, 'completed');

    const cancelled = { ...createRun('B', { idSuffix: 'i' }), status: 'cancelled' as const };
    const r2 = await runPipeline(cancelled, {
      store: fakeStore(),
      makeConversation: make,
      signal: idle,
      hooks: approve,
    });
    assert.equal(r2.status, 'cancelled');
    assert.equal(called, false); // диалоги не создавались
  });

  it('передаёт memoryContext в этапы (планирование видит контекст)', async t => {
    const run = createRun('Задача', { idSuffix: 'k' });
    let planPrompt = '';
    const make = (systemPrompt: string, limits?: GenerationLimits) => {
      const client = clientWith(t, async messages => {
        if (systemPrompt.includes('планировщик')) planPrompt = messages.at(-1)?.content ?? '';
        return { content: content()[stageOf(systemPrompt)](), usage: undefined };
      });
      return new Conversation(client, {
        systemPrompt,
        temperature: 0.5,
        contextTokens: 8192,
        requestTimeoutMs: 5000,
        limits,
      });
    };
    await runPipeline(run, {
      store: fakeStore(),
      makeConversation: make,
      signal: idle,
      memoryContext: 'ПАМЯТЬ ЗАДАЧИ',
      hooks: approve,
    });
    assert.match(planPrompt, /ПАМЯТЬ ЗАДАЧИ/);
  });

  it('--ephemeral (store=null): завершается, файлы-артефакты не пишутся', async t => {
    const run = createRun('Задача', { idSuffix: 'j' });
    const result = await runPipeline(run, {
      store: null,
      makeConversation: makeConversation(t, content()),
      signal: idle,
      hooks: approve,
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.artifacts.execution?.files, []);
  });
});
