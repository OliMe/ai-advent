import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePlanning,
  parseExecution,
  parseVerification,
  parseCompletion,
  runPlanning,
  runExecution,
  runVerification,
  runCompletion,
  extractJsonObject,
  Conversation,
  createRun,
} from '../index.ts';
import type { GenerationLimits, StageContext, TaskRun, TeamPlan } from '../index.ts';
import { clientWith } from './helpers.ts';

/** Фабрика диалога с подменённым клиентом: всегда отдаёт `content`; ловит промпт. */
function makeConv(t: TestContext, content: string, capture?: (prompt: string) => void) {
  return (systemPrompt: string, limits?: GenerationLimits) => {
    const client = clientWith(t, async messages => {
      capture?.(messages.at(-1)?.content ?? '');
      return { content, usage: undefined };
    });
    return new Conversation(client, {
      systemPrompt,
      temperature: 0.5,
      contextTokens: 8192,
      requestTimeoutMs: 5000,
      limits,
    });
  };
}

function ctxWith(
  t: TestContext,
  content: string,
  run: TaskRun,
  capture?: (prompt: string) => void,
  writeArtifact: (name: string, content: string) => string | null = () => null,
  memoryContext = '',
): StageContext {
  return {
    run,
    makeConversation: makeConv(t, content, capture),
    writeArtifact,
    memoryContext: () => memoryContext,
  };
}

describe('разбор артефактов (C + фолбэк D)', () => {
  it('parsePlanning: JSON и фолбэк', () => {
    const fromJson = parsePlanning('{"steps":["a",1],"criteria":["c"],"text":"план"}');
    assert.deepEqual(fromJson, { steps: ['a'], criteria: ['c'], text: 'план' }); // нестроки отброшены

    const noText = parsePlanning('{"steps":["a"]}'); // text отсутствует → берём весь контент
    assert.equal(noText.text, '{"steps":["a"]}');

    const fallback = parsePlanning('- шаг1\n- шаг2\nпросто строка');
    assert.deepEqual(fallback.steps, ['шаг1', 'шаг2']);
    assert.equal(fallback.criteria.length, 0);
    assert.equal(fallback.text, '- шаг1\n- шаг2\nпросто строка');
  });

  it('parseExecution: плоский результат + снятие markdown-ограждения', () => {
    // Обычный текст: summary — первая содержательная строка, text — результат целиком.
    const plain = parseExecution('первая строка\nвторая');
    assert.equal(plain.summary, 'первая строка');
    assert.deepEqual(plain.log, []);
    assert.equal(plain.text, 'первая строка\nвторая');
    // Markdown-ограждение снимается, результат — внутренний код.
    const fenced = parseExecution('```ts\nconst x = 1;\n```');
    assert.equal(fenced.text, 'const x = 1;');
    assert.equal(fenced.summary, 'const x = 1;');
    // Пустой/пробельный ввод → пустые summary и text.
    const empty = parseExecution('   ');
    assert.equal(empty.summary, '');
    assert.equal(empty.text, '');
  });

  it('parseObject: валидный JSON не-объект трактуется как фолбэк', () => {
    const planning = parsePlanning('42'); // число — не объект
    assert.equal(planning.text, '42');
    assert.deepEqual(planning.steps, []);
    assert.equal(parsePlanning('null').text, 'null'); // JSON null — тоже не объект
  });

  it('extractJsonObject: первый сбалансированный блок с учётом строк, иначе null', () => {
    assert.equal(extractJsonObject('шум {"a":1} хвост'), '{"a":1}');
    assert.equal(extractJsonObject('prefix {"a":"}"} suffix'), '{"a":"}"}'); // } внутри строки не закрывает
    assert.equal(extractJsonObject('{"a":"\\""}'), '{"a":"\\""}'); // экранированная кавычка не закрывает строку
    assert.equal(extractJsonObject('нет фигурных скобок'), null);
    assert.equal(extractJsonObject('{"a":1'), null); // незакрытый объект
  });

  it('parseObject: JSON, обёрнутый прозой, всё равно разбирается', () => {
    const planning = parsePlanning(
      'Вот план: {"steps":["s"],"criteria":["c"],"text":"t"}. Готово.',
    );
    assert.deepEqual(planning.steps, ['s']);
    assert.deepEqual(planning.criteria, ['c']);
    assert.equal(planning.text, 't');
  });

  it('parseObject: похоже на объект, но не JSON → фолбэк', () => {
    // extractJsonObject вернёт «{не json}», но JSON.parse упадёт → уходим в фолбэк.
    const planning = parsePlanning('{не json}');
    assert.deepEqual(planning.steps, []);
    assert.equal(planning.text, '{не json}');
  });

  it('parseVerification: пустой ответ → провал', () => {
    const v = parseVerification('   ');
    assert.equal(v.passed, false);
    assert.deepEqual(v.issues, ['Проверка не вернула ответа']);
  });

  it('parseVerification: JSON passed true/false и фолбэк', () => {
    assert.equal(parseVerification('{"passed":true,"issues":[]}').passed, true);
    const failed = parseVerification('{"passed":false,"issues":["нет тестов"]}');
    assert.equal(failed.passed, false);
    assert.deepEqual(failed.issues, ['нет тестов']);

    assert.equal(parseVerification('всё хорошо').passed, true); // нет слова провала
    const fbFail = parseVerification('Проверка: FAIL\n- нет тестов');
    assert.equal(fbFail.passed, false);
    assert.deepEqual(fbFail.issues, ['нет тестов']);
  });

  it('parseCompletion: JSON и фолбэк', () => {
    assert.deepEqual(parseCompletion('{"summary":"итог","text":"резюме"}'), {
      summary: 'итог',
      text: 'резюме',
    });
    const noFields = parseCompletion('{"x":1}'); // нет summary/text → берём из контента
    assert.equal(noFields.summary, '{"x":1}');
    assert.equal(noFields.text, '{"x":1}');
    const fb = parseCompletion('готово\nдетали');
    assert.equal(fb.summary, 'готово');
    assert.equal(fb.text, 'готово\nдетали');
  });
});

describe('раннеры этапов', () => {
  it('runPlanning: учитывает правку пользователя в промпте', async t => {
    const run = { ...createRun('Сайт'), correction: 'добавь тёмную тему' };
    let prompt = '';
    const artifact = await runPlanning(
      ctxWith(t, '{"steps":["s"],"criteria":["c"],"text":"план"}', run, p => (prompt = p)),
    );
    assert.match(prompt, /Задача: Сайт/);
    assert.match(prompt, /тёмную тему/);
    assert.deepEqual(artifact.steps, ['s']);
  });

  it('runPlanning: добирает пустые критерии повторным запросом', async t => {
    const run = createRun('Сайт');
    const replies = [
      '{"steps":["s"],"criteria":[],"text":"план прозой"}', // первый раз критерии пусты
      '{"steps":["s"],"criteria":["к1"],"text":"ок"}', // на доборе — есть
    ];
    let index = 0;
    const ctx: StageContext = {
      run,
      makeConversation: () =>
        new Conversation(
          clientWith(t, async () => ({
            content: replies[Math.min(index++, replies.length - 1)],
            usage: undefined,
          })),
          {
            systemPrompt: 'планировщик',
            temperature: 0.5,
            contextTokens: 8192,
            requestTimeoutMs: 5000,
          },
        ),
      writeArtifact: () => null,
      memoryContext: () => '',
    };
    const artifact = await runPlanning(ctx);
    assert.deepEqual(artifact.criteria, ['к1']); // критерии добраны со второго раза
  });

  it('runPlanning: добирает критерии для плана прозой (без шагов)', async t => {
    const run = createRun('Сайт');
    const replies = [
      '{"steps":[],"criteria":[],"text":"Подробный план действий, описанный прозой."}', // прозой, без критериев
      '{"criteria":["к1","к2"]}', // направленный добор критериев
    ];
    let index = 0;
    const ctx: StageContext = {
      run,
      makeConversation: () =>
        new Conversation(
          clientWith(t, async () => ({
            content: replies[Math.min(index++, replies.length - 1)],
            usage: undefined,
          })),
          {
            systemPrompt: 'планировщик',
            temperature: 0.5,
            contextTokens: 8192,
            requestTimeoutMs: 5000,
          },
        ),
      writeArtifact: () => null,
      memoryContext: () => '',
    };
    const artifact = await runPlanning(ctx);
    assert.deepEqual(artifact.criteria, ['к1', 'к2']); // критерии добраны направленным запросом
    assert.equal(artifact.steps.length, 0); // шаги остались в прозе (text)
  });

  it('runPlanning: критерии есть сразу → добор не запускается', async t => {
    const run = createRun('Сайт');
    let calls = 0;
    const ctx: StageContext = {
      run,
      makeConversation: () =>
        new Conversation(
          clientWith(t, async () => {
            calls++;
            return {
              content: JSON.stringify({ steps: [], criteria: ['к1'], text: 'план прозой' }),
              usage: undefined,
            };
          }),
          {
            systemPrompt: 'планировщик',
            temperature: 0.5,
            contextTokens: 8192,
            requestTimeoutMs: 5000,
          },
        ),
      writeArtifact: () => null,
      memoryContext: () => '',
    };
    const artifact = await runPlanning(ctx);
    assert.equal(calls, 1); // критерии уже есть — добора нет
    assert.deepEqual(artifact.criteria, ['к1']);
  });

  it('runPlanning: добор не помог → возвращаем план как есть', async t => {
    const run = createRun('Сайт');
    const ctx: StageContext = {
      run,
      makeConversation: () =>
        new Conversation(
          clientWith(t, async () => ({
            content: '{"steps":["s"],"criteria":[],"text":"всё прозой"}',
            usage: undefined,
          })),
          {
            systemPrompt: 'планировщик',
            temperature: 0.5,
            contextTokens: 8192,
            requestTimeoutMs: 5000,
          },
        ),
      writeArtifact: () => null,
      memoryContext: () => '',
    };
    const artifact = await runPlanning(ctx);
    assert.deepEqual(artifact.criteria, []); // после исчерпания доборов — как есть
  });

  it('runPlanning и runExecution подмешивают память задачи в промпт', async t => {
    const run = createRun('Сайт');
    run.artifacts.planning = { steps: ['s'], criteria: ['c'], text: 'план' };
    let planPrompt = '';
    await runPlanning(
      ctxWith(
        t,
        '{"steps":["s"],"criteria":["c"],"text":"план"}', // непустые критерии → без добора
        run,
        p => (planPrompt = p),
        () => null,
        'КОНТЕКСТ ПАМЯТИ',
      ),
    );
    assert.match(planPrompt, /КОНТЕКСТ ПАМЯТИ/);
    assert.match(planPrompt, /Задача: Сайт/);

    let execPrompt = '';
    await runExecution(
      ctxWith(
        t,
        '{"summary":"s","text":"t"}',
        run,
        p => (execPrompt = p),
        () => null,
        'КОНТЕКСТ ПАМЯТИ',
      ),
    );
    assert.match(execPrompt, /КОНТЕКСТ ПАМЯТИ/);
  });

  it('runExecution: пишет файл-артефакт и подаёт замечания проверки', async t => {
    const run = createRun('Сайт');
    run.artifacts.planning = { steps: ['s'], criteria: ['c'], text: 'план' };
    run.artifacts.verification = { passed: false, issues: ['нет валидации'], text: 'плохо' };
    const written: { name: string; content: string }[] = [];
    let prompt = '';
    const artifact = await runExecution(
      ctxWith(
        t,
        'Готово\nconst code = 1;',
        run,
        p => (prompt = p),
        (name, content) => {
          written.push({ name, content });
          return `/runs/x/${name}`;
        },
      ),
    );
    assert.match(prompt, /нет валидации/); // замечания проверки в промпте
    assert.deepEqual(artifact.files, ['/runs/x/execution-1.md']);
    assert.deepEqual(written, [{ name: 'execution-1.md', content: 'Готово\nconst code = 1;' }]);
  });

  it('runExecution: доработка требует ПОЛНЫЙ результат с предыдущим и правкой', async t => {
    const run = createRun('Сайт');
    run.artifacts.planning = { steps: ['s'], criteria: ['c'], text: 'план' };
    // Прошлый результат есть, замечаний проверки нет, но есть правка пользователя (отказ).
    run.artifacts.execution = {
      summary: 'старое',
      files: [],
      log: [],
      text: 'ПРЕДЫДУЩИЙ РЕЗУЛЬТАТ',
    };
    run.correction = 'добавь раздел метрик';
    let prompt = '';
    await runExecution(ctxWith(t, 'новый полный результат', run, p => (prompt = p)));
    assert.match(prompt, /ПОЛНЫЙ итоговый результат ЦЕЛИКОМ/); // требуем целый результат, не дельту
    assert.match(prompt, /ПРЕДЫДУЩИЙ РЕЗУЛЬТАТ/); // прошлый результат — для доработки
    assert.match(prompt, /добавь раздел метрик/); // правка пользователя
    assert.doesNotMatch(prompt, /Замечания проверки/); // замечаний нет — блок опущен
  });

  it('runExecution: при пустых шагах подаёт план прозой из text', async t => {
    const run = createRun('Сайт');
    run.artifacts.planning = { steps: [], criteria: ['c'], text: 'план прозой словами' };
    let prompt = '';
    await runExecution(ctxWith(t, 'результат', run, p => (prompt = p)));
    assert.match(prompt, /План:\nплан прозой словами/); // text вместо пустых шагов
  });

  it('runExecution: без хранилища files пуст', async t => {
    const run = createRun('Сайт');
    run.artifacts.planning = { steps: [], criteria: [], text: '' };
    const artifact = await runExecution(ctxWith(t, '{"summary":"s","text":"t"}', run));
    assert.deepEqual(artifact.files, []);
  });

  it('runVerification и runCompletion возвращают разобранные артефакты', async t => {
    const run = createRun('Сайт');
    run.artifacts.planning = { steps: [], criteria: ['c1'], text: '' };
    run.artifacts.execution = { summary: 'готово', files: [], log: [], text: 'результат' };
    let vPrompt = '';
    const v = await runVerification(
      ctxWith(t, '{"passed":true,"issues":[],"text":"ок"}', run, p => (vPrompt = p)),
    );
    assert.equal(v.passed, true);
    assert.match(vPrompt, /c1/);
    assert.match(vPrompt, /результат/);

    run.artifacts.verification = v;
    const c = await runCompletion(ctxWith(t, '{"summary":"итог","text":"резюме"}', run));
    assert.equal(c.summary, 'итог');
  });

  it('раннеры с пустым прогоном используют запасные значения', async t => {
    const run = createRun('Пустая'); // без артефактов
    const exec = await runExecution(ctxWith(t, '{"summary":"s","text":"t"}', run));
    assert.deepEqual(exec.files, []); // writeArtifact по умолчанию null
    const c = await runCompletion(ctxWith(t, '{"summary":"итог","text":"t"}', run));
    assert.equal(c.summary, 'итог'); // verification отсутствует → «с замечаниями» в промпте
  });

  it('runVerification: совсем пустой план → провал без вызова модели', async t => {
    // (а) плана нет
    let called = false;
    const noPlan = createRun('Пустая');
    const v1 = await runVerification(ctxWith(t, '{"passed":true}', noPlan, () => (called = true)));
    assert.equal(v1.passed, false);
    assert.match(v1.issues[0], /План пуст/);

    // (б) план есть, но пуст полностью (ни критериев, ни шагов, ни текста)
    const empty = createRun('Пустая');
    empty.artifacts.planning = { steps: [], criteria: [], text: '' };
    const v2 = await runVerification(ctxWith(t, '{"passed":true}', empty, () => (called = true)));
    assert.equal(v2.passed, false);
    assert.equal(called, false); // в обоих случаях модель не звали
  });

  it('runVerification: нет критериев → сверяет по шагам, иначе по тексту плана', async t => {
    // Критериев нет, но есть шаги → сверяем по шагам (модель зовём).
    const bySteps = createRun('Сайт');
    bySteps.artifacts.planning = { steps: ['шаг A'], criteria: [], text: 'п' };
    bySteps.artifacts.execution = { summary: 'готово', files: [], log: [], text: 'результат' };
    let stepsPrompt = '';
    const v1 = await runVerification(
      ctxWith(t, '{"passed":true,"issues":[]}', bySteps, p => (stepsPrompt = p)),
    );
    assert.equal(v1.passed, true);
    assert.match(stepsPrompt, /Шаги плана[\s\S]*шаг A/);

    // Ни критериев, ни шагов, но есть текст → сверяем по тексту.
    const byText = createRun('Сайт');
    byText.artifacts.planning = { steps: [], criteria: [], text: 'план прозой' };
    let textPrompt = '';
    const v2 = await runVerification(
      ctxWith(t, '{"passed":true,"issues":[]}', byText, p => (textPrompt = p)),
    );
    assert.equal(v2.passed, true);
    assert.match(textPrompt, /сверяй результат по нему[\s\S]*план прозой/);
  });

  it('runVerification: в промпт идут память, заголовок, шаги; результат — text или summary', async t => {
    const run = createRun('Сайт');
    run.artifacts.planning = { steps: ['шаг1'], criteria: ['c1'], text: 'план' };
    // text пустой → берётся summary (хрупкость поля результата).
    run.artifacts.execution = { summary: 'РЕЗЮМЕ', files: [], log: [], text: '' };
    let prompt = '';
    await runVerification(
      ctxWith(
        t,
        '{"passed":true,"issues":[],"text":"ок"}',
        run,
        p => (prompt = p),
        () => null,
        'ПАМЯТЬ',
      ),
    );
    assert.match(prompt, /ПАМЯТЬ/); // память задачи
    assert.match(prompt, /Задача: Сайт/); // заголовок
    assert.match(prompt, /шаг1/); // шаги плана
    assert.match(prompt, /c1/); // критерии
    assert.match(prompt, /РЕЗЮМЕ/); // результат из summary, т.к. text пуст
  });

  it('runVerification: нет артефакта выполнения → блок результата пуст', async t => {
    const run = createRun('Сайт');
    run.artifacts.planning = { steps: [], criteria: ['c1'], text: '' }; // execution отсутствует
    let prompt = '';
    await runVerification(ctxWith(t, '{"passed":false,"issues":["x"]}', run, p => (prompt = p)));
    assert.match(prompt, /Результат на проверку:\n$/); // после заголовка пусто
  });
});

describe('командное планирование (несколько агентов)', () => {
  /** Диалог, отвечающий по роли системного промпта: оркестратор / эксперт / синтезатор. */
  function teamConversation(
    t: TestContext,
    replies: { orchestrator: string; role: (system: string) => string; synthesizer: string },
    capture?: (call: { system: string; temperature?: number }) => void,
  ) {
    return (system: string, limits?: GenerationLimits, temperature?: number) => {
      const client = clientWith(t, async () => {
        capture?.({ system, temperature });
        if (system.includes('оркестратор команды')) {
          return { content: replies.orchestrator, usage: undefined };
        }
        if (system.includes('в команде планирования')) {
          return { content: replies.role(system), usage: undefined };
        }
        return { content: replies.synthesizer, usage: undefined }; // ведущий планировщик
      });
      return new Conversation(client, {
        systemPrompt: system,
        temperature: temperature ?? 0.5,
        contextTokens: 8192,
        requestTimeoutMs: 5000,
        limits,
      });
    };
  }

  it('команда ролей → синтез единого плана и запись вкладов', async t => {
    const run = createRun('Сложная система', { idSuffix: 'team' });
    const written: Array<{ name: string }> = [];
    const calls: Array<{ system: string; temperature?: number }> = [];
    const teams: TeamPlan[] = [];
    const ctx: StageContext = {
      run,
      makeConversation: teamConversation(
        t,
        {
          orchestrator:
            '{"roles":[{"name":"архитектор","focus":"структура","temperature":0.2},' +
            '{"name":"безопасность","focus":"риски"}],"rationale":"сложно"}',
          role: system => (system.includes('архитектор') ? '- модульность' : '- валидация'),
          synthesizer: '{"steps":["s1","s2"],"criteria":["c1"],"text":"единый план"}',
        },
        call => calls.push(call),
      ),
      writeArtifact: name => {
        written.push({ name });
        return `/runs/${name}`;
      },
      memoryContext: () => '',
      maxStageAgents: 4,
      stageAgentConcurrency: 2,
      reportTeam: team => teams.push(team),
    };

    const artifact = await runPlanning(ctx);

    assert.deepEqual(artifact.steps, ['s1', 's2']);
    assert.deepEqual(artifact.criteria, ['c1']);
    assert.deepEqual(
      artifact.contributions?.map(contribution => contribution.role),
      ['архитектор', 'безопасность'],
    );
    // Вклады экспертов записаны файлами с безопасными именами.
    assert.deepEqual(
      written.map(file => file.name),
      ['planning-team-1-архитектор.md', 'planning-team-2-безопасность.md'],
    );
    // Решение оркестратора сообщено драйверу.
    assert.equal(teams.length, 1);
    assert.equal(teams[0]?.roles.length, 2);
    // Температура роли проброшена в её диалог (именно роль-эксперта, не оркестратора).
    const architectCall = calls.find(
      call => call.system.includes('в команде планирования') && call.system.includes('архитектор'),
    );
    assert.equal(architectCall?.temperature, 0.2);
  });

  it('все эксперты упали → откат к одиночному плану', async t => {
    const run = createRun('Задача', { idSuffix: 'fb' });
    const make = (system: string) => {
      const client = clientWith(t, async () => {
        if (system.includes('оркестратор команды')) {
          return {
            content: '{"roles":[{"name":"a","focus":""},{"name":"b","focus":""}],"rationale":""}',
            usage: undefined,
          };
        }
        if (system.includes('в команде планирования')) {
          throw new Error('эксперт упал');
        }
        return { content: '{"steps":["solo"],"criteria":["c"],"text":"соло"}', usage: undefined };
      });
      return new Conversation(client, {
        systemPrompt: system,
        temperature: 0.5,
        contextTokens: 8192,
        requestTimeoutMs: 5000,
      });
    };
    const ctx: StageContext = {
      run,
      makeConversation: make,
      writeArtifact: () => null,
      memoryContext: () => '',
      maxStageAgents: 3,
      // stageAgentConcurrency не задан → дефолт (1) внутри раннера.
    };

    const artifact = await runPlanning(ctx);

    assert.deepEqual(artifact.steps, ['solo']); // одиночный планировщик
    assert.equal(artifact.contributions, undefined); // соло-путь без вкладов команды
  });
});
