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
  structuredLimits,
  PLANNING_SCHEMA,
  InvariantViolationError,
} from '../index.ts';
import type {
  GenerationLimits,
  StageContext,
  TaskRun,
  TeamPlan,
  ToolSet,
  FileWorkspace,
  CommandCheck,
  CommandResult,
  ProjectCommands,
} from '../index.ts';
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

  it('parsePlanning: шаги-ОБЪЕКТЫ разворачиваются в строки (слабая модель)', () => {
    // llama3.2:3b кладёт в steps объекты {name, description, result} — не теряем их молча.
    const withObjects = parsePlanning(
      '{"steps":[{"name":"Создать файл","description":"HTML-каркас","result":{"time":30}},' +
        '{"description":"Добавить стили"}],"criteria":[{"criterion":"Страница открывается"}],"text":"t"}',
    );
    assert.deepEqual(withObjects.steps, ['Создать файл', 'Добавить стили']); // взято name / description
    assert.deepEqual(withObjects.criteria, ['Страница открывается']); // взято criterion
  });

  it('parsePlanning: объект без текстового поля и не-объект отбрасываются', () => {
    const dropped = parsePlanning(
      '{"steps":[{"result":{"x":1}},42,"живой шаг"],"criteria":[],"text":"t"}',
    );
    assert.deepEqual(dropped.steps, ['живой шаг']); // объект без текста и число отброшены
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
  it('инструменты идут планировщику и исполнителю, но не проверяющему/завершающему', async t => {
    const tools: ToolSet = { specs: () => [], call: async () => '' };
    const seen = new Map<string, boolean>(); // персона (первые слова) → переданы ли инструменты
    const make: StageContext['makeConversation'] = (systemPrompt, limits, temperature, toolset) => {
      const persona = systemPrompt.split(' ').slice(0, 3).join(' ');
      if (!seen.has(persona)) {
        seen.set(persona, toolset !== undefined);
      }
      const client = clientWith(t, async () => ({
        content: '{"steps":["s"],"criteria":["c"],"text":"п","passed":true,"summary":"и"}',
        usage: undefined,
      }));
      return new Conversation(client, {
        systemPrompt,
        temperature: temperature ?? 0.5,
        contextTokens: 8192,
        requestTimeoutMs: 5000,
        limits,
      });
    };
    const run = createRun('Задача');
    const ctx: StageContext = {
      run,
      makeConversation: make,
      writeArtifact: () => null,
      memoryContext: () => '',
      tools,
    };

    run.artifacts.planning = await runPlanning(ctx);
    run.artifacts.execution = await runExecution(ctx);
    run.artifacts.verification = await runVerification(ctx);
    await runCompletion(ctx);

    assert.equal(seen.get('Ты — планировщик.'), true);
    assert.equal(seen.get('Ты — исполнитель.'), true);
    assert.equal(seen.get('Ты — проверяющий.'), false);
    assert.equal(seen.get('Ты — завершающий.'), false);
  });

  it('executorModel уходит роли выполнения, остальные роли — на дефолтную модель', async t => {
    const models = new Map<string, string | undefined>(); // персона → модель диалога
    const make: StageContext['makeConversation'] = (
      systemPrompt,
      limits,
      temperature,
      tools,
      model,
    ) => {
      const persona = systemPrompt.split(' ').slice(0, 3).join(' ');
      if (!models.has(persona)) models.set(persona, model);
      const client = clientWith(t, async () => ({
        content: '{"steps":["s"],"criteria":["c"],"text":"п","passed":true,"summary":"и"}',
        usage: undefined,
      }));
      return new Conversation(client, {
        systemPrompt,
        temperature: temperature ?? 0.5,
        model,
        contextTokens: 8192,
        requestTimeoutMs: 5000,
        limits,
      });
    };
    const run = createRun('Задача', { idSuffix: 'exec-model' });
    const ctx: StageContext = {
      run,
      makeConversation: make,
      writeArtifact: () => null,
      memoryContext: () => '',
      executorModel: 'qwen2.5-coder:7b',
    };

    run.artifacts.planning = await runPlanning(ctx);
    run.artifacts.execution = await runExecution(ctx);
    run.artifacts.verification = await runVerification(ctx);
    await runCompletion(ctx);

    assert.equal(models.get('Ты — исполнитель.'), 'qwen2.5-coder:7b'); // роль выполнения → своя модель
    assert.equal(models.get('Ты — планировщик.'), undefined); // остальные — дефолтная (фолбэк)
    assert.equal(models.get('Ты — проверяющий.'), undefined);
    assert.equal(models.get('Ты — завершающий.'), undefined);
  });

  it('этапы идут на своих температурах: планирование 0.3, выполнение 0.2, проверка 0, завершение 0.2', async t => {
    const temps = new Map<string, number | undefined>(); // персона → температура
    const make: StageContext['makeConversation'] = (systemPrompt, limits, temperature) => {
      const persona = systemPrompt.split(' ').slice(0, 3).join(' ');
      if (!temps.has(persona)) temps.set(persona, temperature);
      const client = clientWith(t, async () => ({
        content: '{"steps":["s"],"criteria":["c"],"text":"п","passed":true,"summary":"и"}',
        usage: undefined,
      }));
      return new Conversation(client, {
        systemPrompt,
        temperature: temperature ?? 0.5,
        contextTokens: 8192,
        requestTimeoutMs: 5000,
        limits,
      });
    };
    const run = createRun('Задача');
    const ctx: StageContext = {
      run,
      makeConversation: make,
      writeArtifact: () => null,
      memoryContext: () => '',
    };
    run.artifacts.planning = await runPlanning(ctx);
    run.artifacts.execution = await runExecution(ctx);
    run.artifacts.verification = await runVerification(ctx);
    await runCompletion(ctx);
    assert.equal(temps.get('Ты — планировщик.'), 0.3);
    assert.equal(temps.get('Ты — исполнитель.'), 0.2);
    assert.equal(temps.get('Ты — проверяющий.'), 0);
    assert.equal(temps.get('Ты — завершающий.'), 0.2);
  });

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

  it('runPlanning и runExecution подают явные требования прогона целиком', async t => {
    const run = createRun('План');
    run.artifacts.requirements = {
      collected: [
        'Список задач с оценкой времени в часах',
        'Профиль исполнителя для каждой задачи',
      ],
      text: '',
    };
    let planPrompt = '';
    await runPlanning(
      ctxWith(t, '{"steps":["s"],"criteria":["c"],"text":"план"}', run, p => (planPrompt = p)),
    );
    assert.match(planPrompt, /оценкой времени в часах/); // требование к формату — в планировании
    assert.match(planPrompt, /Профиль исполнителя/);

    run.artifacts.planning = { steps: ['s'], criteria: ['c'], text: 'план' };
    let execPrompt = '';
    await runExecution(ctxWith(t, 'результат', run, p => (execPrompt = p)));
    assert.match(execPrompt, /оценкой времени в часах/); // и в выполнении
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
    capture?: (call: {
      system: string;
      temperature?: number;
      tools?: ToolSet;
      prompt: string;
    }) => void,
  ) {
    return (system: string, limits?: GenerationLimits, temperature?: number, tools?: ToolSet) => {
      const client = clientWith(t, async messages => {
        capture?.({ system, temperature, tools, prompt: messages.at(-1)?.content ?? '' });
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
    const calls: Array<{
      system: string;
      temperature?: number;
      tools?: ToolSet;
      prompt: string;
    }> = [];
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
    // Синтезатор плана идёт на температуре планирования (0.3), не на сессионной.
    // Именно синтезатор (его персона начинается с «Ты — ведущий планировщик»), а не роль-эксперт,
    // в промпте которого эта фраза тоже встречается.
    const synthCall = calls.find(call => call.system.startsWith('Ты — ведущий планировщик'));
    assert.equal(synthCall?.temperature, 0.3);
    // Синтезатору инструменты НЕ даём (не уходит в агентный цикл), а вклады экспертов — в его промпте.
    assert.equal(synthCall?.tools, undefined);
    assert.match(synthCall?.prompt ?? '', /Предложения экспертов/);
    assert.match(synthCall?.prompt ?? '', /модульность/); // вклад архитектора
    assert.match(synthCall?.prompt ?? '', /валидация/); // вклад безопасности
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

describe('структурированный вывод этапов (LLM_STRUCTURED_OUTPUTS)', () => {
  /** Фабрика диалога, запоминающая limits каждого агента по его системному промпту. */
  function capturingConversation(
    t: TestContext,
    content: string,
    calls: Array<{ system: string; limits?: GenerationLimits }>,
  ) {
    return (system: string, limits?: GenerationLimits) => {
      calls.push({ system, limits });
      const client = clientWith(t, async () => ({ content, usage: undefined }));
      return new Conversation(client, {
        systemPrompt: system,
        temperature: 0.5,
        contextTokens: 8192,
        requestTimeoutMs: 5000,
        limits,
      });
    };
  }

  function schemaNameOf(limits?: GenerationLimits): string | undefined {
    const format = limits?.responseFormat;
    return format?.type === 'json_schema' ? format.json_schema.name : undefined;
  }

  it('structuredLimits: включено → схема; выключено → undefined (инвариант GLM)', () => {
    const enabled = structuredLimits(true, PLANNING_SCHEMA);
    assert.deepEqual(enabled, {
      responseFormat: { type: 'json_schema', json_schema: PLANNING_SCHEMA },
    });
    assert.equal(structuredLimits(false, PLANNING_SCHEMA), undefined);
    assert.equal(structuredLimits(undefined, PLANNING_SCHEMA), undefined);
  });

  it('включено: планировщик, проверяющий и завершающий получают свои схемы', async t => {
    const run = createRun('Задача', { idSuffix: 'so-on' });
    const calls: Array<{ system: string; limits?: GenerationLimits }> = [];
    const ctx: StageContext = {
      run,
      makeConversation: capturingConversation(
        t,
        '{"steps":["s"],"criteria":["c"],"text":"t","passed":true,"issues":[],"summary":"i"}',
        calls,
      ),
      writeArtifact: () => null,
      memoryContext: () => '',
      structuredOutputs: true,
    };

    run.artifacts.planning = await runPlanning(ctx);
    run.artifacts.execution = await runExecution(ctx);
    run.artifacts.verification = await runVerification(ctx);
    await runCompletion(ctx);

    const planner = calls.find(call => call.system.startsWith('Ты — планировщик'));
    const executor = calls.find(call => call.system.startsWith('Ты — исполнитель'));
    const verifier = calls.find(call => call.system.startsWith('Ты — проверяющий'));
    const completer = calls.find(call => call.system.startsWith('Ты — завершающий'));
    assert.equal(schemaNameOf(planner?.limits), 'planning_artifact');
    assert.equal(schemaNameOf(verifier?.limits), 'verification_artifact');
    assert.equal(schemaNameOf(completer?.limits), 'completion_artifact');
    // Выполнение остаётся плоским текстом: схему ему НЕ навязываем.
    assert.equal(executor?.limits, undefined);
  });

  it('включено: синтезатор командного плана тоже получает схему плана', async t => {
    const run = createRun('Сложная', { idSuffix: 'so-team' });
    const calls: Array<{ system: string; limits?: GenerationLimits }> = [];
    const make = (system: string, limits?: GenerationLimits, temperature?: number) => {
      calls.push({ system, limits });
      const client = clientWith(t, async () => {
        if (system.includes('оркестратор команды')) {
          return {
            content: '{"roles":[{"name":"архитектор"},{"name":"безопасность"}],"rationale":"r"}',
            usage: undefined,
          };
        }
        if (system.includes('в команде планирования')) {
          return { content: '- вклад', usage: undefined };
        }
        return { content: '{"steps":["s"],"criteria":["c"],"text":"t"}', usage: undefined };
      });
      return new Conversation(client, {
        systemPrompt: system,
        temperature: temperature ?? 0.5,
        contextTokens: 8192,
        requestTimeoutMs: 5000,
        limits,
      });
    };
    const ctx: StageContext = {
      run,
      makeConversation: make,
      writeArtifact: () => null,
      memoryContext: () => '',
      maxStageAgents: 4,
      structuredOutputs: true,
    };

    await runPlanning(ctx);

    const synthesizer = calls.find(call => call.system.startsWith('Ты — ведущий планировщик'));
    assert.equal(schemaNameOf(synthesizer?.limits), 'planning_artifact');
    // Роль-эксперты отвечают прозой — схему им не навязываем.
    const role = calls.find(call => call.system.includes('в команде планирования'));
    assert.equal(role?.limits, undefined);
  });

  it('ВЫКЛЮЧЕНО по умолчанию: response_format не уходит провайдеру (GLM не задет)', async t => {
    const run = createRun('Задача', { idSuffix: 'so-off' });
    const calls: Array<{ system: string; limits?: GenerationLimits }> = [];
    const ctx: StageContext = {
      run,
      makeConversation: capturingConversation(
        t,
        '{"steps":["s"],"criteria":["c"],"text":"t","passed":true,"issues":[],"summary":"i"}',
        calls,
      ),
      writeArtifact: () => null,
      memoryContext: () => '',
      // structuredOutputs не задан — прежнее поведение
    };

    run.artifacts.planning = await runPlanning(ctx);
    run.artifacts.execution = await runExecution(ctx);
    run.artifacts.verification = await runVerification(ctx);
    await runCompletion(ctx);

    assert.ok(calls.length >= 4);
    assert.ok(calls.every(call => call.limits === undefined));
  });
});

describe('parseExecution: детерминированный ремонт обёртки', () => {
  it('разворачивает {name, implementation, jsdocComments} → код', () => {
    const artifact = parseExecution(
      '{"name":"bubbleSort","implementation":"function bubbleSort(a){\\n  return a;\\n}",' +
        '"jsdocComments":"/** сортировка */"}',
    );
    assert.equal(artifact.text, 'function bubbleSort(a){\n  return a;\n}');
    assert.equal(artifact.summary, 'function bubbleSort(a){');
  });

  it('снимает ограждение внутри развёрнутого поля', () => {
    const artifact = parseExecution('{"code":"```ts\\nconst a = 1;\\n```"}');
    assert.equal(artifact.text, 'const a = 1;');
  });

  it('пустое поле-результат пропускается в пользу следующего', () => {
    const artifact = parseExecution('{"code":"   ","text":"настоящий результат"}');
    assert.equal(artifact.text, 'настоящий результат');
  });

  it('НЕ калечит задачу, чей результат сам по себе JSON (незнакомые ключи)', () => {
    const source = '{"port":8080,"host":"localhost"}';
    const artifact = parseExecution(source);
    assert.equal(artifact.text, source);
  });

  it('знакомые ключи, но результат не строка → текст как есть', () => {
    const source = '{"name":"x","implementation":42}';
    const artifact = parseExecution(source);
    assert.equal(artifact.text, source);
  });

  it('обычный плоский текст не трогает', () => {
    const artifact = parseExecution('function f() {}\nвторая строка');
    assert.equal(artifact.text, 'function f() {}\nвторая строка');
  });
});

describe('контекст проекта в этапах (День 31)', () => {
  /** Прогон всех этапов с записью промптов каждого агента. */
  async function runAllStages(options: {
    t: TestContext;
    projectContext?: () => string;
    retrieveProjectDocs?: (query: string) => Promise<string[]>;
  }): Promise<{ prompts: string[]; queries: string[] }> {
    const prompts: string[] = [];
    const queries: string[] = [];
    const run = createRun('Добавить эндпоинт /orders');
    const ctx: StageContext = {
      run,
      makeConversation: makeConv(
        options.t,
        '{"steps":["шаг"],"criteria":["критерий"],"text":"план","passed":true,"issues":[],"summary":"итог"}',
        prompt => prompts.push(prompt),
      ),
      writeArtifact: () => null,
      memoryContext: () => '',
      ...(options.projectContext === undefined ? {} : { projectContext: options.projectContext }),
      ...(options.retrieveProjectDocs === undefined
        ? {}
        : {
            retrieveProjectDocs: async (query: string) => {
              queries.push(query);
              return options.retrieveProjectDocs!(query);
            },
          }),
    };

    run.artifacts.planning = await runPlanning(ctx);
    run.artifacts.execution = await runExecution(ctx);
    run.artifacts.verification = await runVerification(ctx);
    await runCompletion(ctx);
    return { prompts, queries };
  }

  it('карточка проекта уходит ВСЕМ этапам — работаем в конкретном репозитории, а не в воздухе', async t => {
    const { prompts } = await runAllStages({
      t,
      projectContext: () =>
        'Проект «shop-api»\n- корень: /work/shop-api\n- команды: тесты: `npm test`',
    });

    assert.ok(prompts.length >= 4);
    for (const prompt of prompts) {
      assert.match(prompt, /Проект «shop-api»/);
    }
  });

  it('документация проекта — адресно: планирование и проверка, но не выполнение и завершение', async t => {
    const { prompts, queries } = await runAllStages({
      t,
      retrieveProjectDocs: async () => [
        '[1] README.md#1 · docs › README (0.9)\nЭндпоинты — в src/routes.',
      ],
    });

    // Запрос строится по цели задачи; поиск идёт ровно дважды — планирование и проверка.
    assert.deepEqual(queries, ['Добавить эндпоинт /orders', 'Добавить эндпоинт /orders']);
    const withDocs = prompts.filter(prompt => prompt.includes('Эндпоинты — в src/routes.'));
    assert.equal(withDocs.length, 2);
  });

  it('без проекта поведение прежнее — ни карточки, ни поиска (регресса нет)', async t => {
    const { prompts, queries } = await runAllStages({ t });

    assert.deepEqual(queries, []);
    for (const prompt of prompts) {
      assert.doesNotMatch(prompt, /Проект «/);
      assert.doesNotMatch(prompt, /Документация проекта/);
    }
  });

  it('поиск ничего не нашёл — блок документации не добавляется (выдумывать нечего)', async t => {
    const { prompts } = await runAllStages({ t, retrieveProjectDocs: async () => [] });

    for (const prompt of prompts) {
      assert.doesNotMatch(prompt, /Документация проекта/);
    }
  });
});

describe('работа с файлами и командами (День 34)', () => {
  /** Фейковое файловое пространство: инструменты (для сигнала «переданы») + канный diff/файлы. */
  function fakeWorkspace(
    diff: string,
    files: string[],
    calls?: string[],
    projectFiles: string[] = [],
  ): FileWorkspace {
    return {
      tools: {
        specs: () => [{ name: 'write_file', description: 'создать/изменить файл', parameters: {} }],
        call: async name => {
          calls?.push(name);
          return 'ok';
        },
      },
      changeSummary: async () => ({ diff, files }),
      listFiles: async () => projectFiles,
    };
  }

  /** Фейковый запуск команд: результат берётся по строке команды (недостающие поля — по нулям). */
  function checkWith(
    commands: ProjectCommands,
    byCommand: Record<string, Partial<CommandResult>> = {},
    ran?: string[],
  ): CommandCheck {
    return {
      commands,
      run: async command => {
        ran?.push(command);
        const canned = byCommand[command] ?? {};
        return {
          command,
          code: canned.code ?? 0,
          stdout: canned.stdout ?? '',
          stderr: canned.stderr ?? '',
          timedOut: canned.timedOut ?? false,
        };
      },
    };
  }

  /** Готовый план для этапа выполнения/проверки. */
  function planned(run: TaskRun): TaskRun {
    run.artifacts.planning = { steps: ['изменить файл'], criteria: ['файл обновлён'], text: '' };
    return run;
  }

  it('runExecution с fileWorkspace: исполнитель правит файлы, артефакт несёт diff и файлы', async t => {
    const run = planned(createRun('Обнови README', { idSuffix: 'fx1' }));
    let systemSeen = '';
    let toolsPassed = false;
    const make: StageContext['makeConversation'] = (systemPrompt, limits, temperature, toolset) => {
      systemSeen = systemPrompt;
      toolsPassed = toolset !== undefined && toolset.specs().length > 0;
      const client = clientWith(t, async () => ({ content: 'Изменил README.md', usage: undefined }));
      return new Conversation(client, {
        systemPrompt,
        temperature: temperature ?? 0.5,
        contextTokens: 8192,
        requestTimeoutMs: 5000,
        limits,
      });
    };
    const artifact = await runExecution({
      run,
      makeConversation: make,
      writeArtifact: () => null,
      memoryContext: () => '',
      fileWorkspace: fakeWorkspace('--- a/README.md\n+++ b/README.md\n+новое', ['README.md']),
    });

    assert.ok(toolsPassed); // исполнителю переданы инструменты файлового пространства
    assert.match(systemSeen, /работающий с ФАЙЛАМИ/); // персона файлового исполнителя
    assert.deepEqual(artifact.files, ['README.md']);
    assert.match(artifact.text, /Изменил README\.md/);
    assert.match(artifact.text, /Изменения в файлах:/);
    assert.match(artifact.text, /\+новое/);
    assert.match(artifact.summary, /Изменено файлов: 1 \(README\.md\)/);
  });

  it('runExecution с fileWorkspace: обрыв агентного цикла не теряет правки (снимает diff)', async t => {
    const run = planned(createRun('Обнови зависимости', { idSuffix: 'cut' }));
    const make: StageContext['makeConversation'] = systemPrompt => {
      const client = clientWith(t, async () => {
        throw new Error('Превышен лимит раундов вызова инструментов (20).');
      });
      return new Conversation(client, {
        systemPrompt,
        temperature: 0.2,
        contextTokens: 8192,
        requestTimeoutMs: 5000,
      });
    };
    const artifact = await runExecution({
      run,
      makeConversation: make,
      writeArtifact: () => null,
      memoryContext: () => '',
      fileWorkspace: fakeWorkspace('--- a/package.json\n+++ b/package.json\n+обновлено', ['package.json']),
    });

    assert.match(artifact.text, /Выполнение прервано/); // пометка обрыва
    assert.match(artifact.text, /\+обновлено/); // но diff сохранён — работа не потеряна
    assert.deepEqual(artifact.files, ['package.json']);
  });

  it('runExecution с fileWorkspace: обрыв не-Error значением тоже сохраняет правки', async t => {
    const run = planned(createRun('Y', { idSuffix: 'cut2' }));
    const make: StageContext['makeConversation'] = systemPrompt => {
      const client = clientWith(t, async () => {
        throw 'строковый сбой'; // не Error → ветка String(error)
      });
      return new Conversation(client, {
        systemPrompt,
        temperature: 0.2,
        contextTokens: 8192,
        requestTimeoutMs: 5000,
      });
    };
    const artifact = await runExecution({
      run,
      makeConversation: make,
      writeArtifact: () => null,
      memoryContext: () => '',
      fileWorkspace: fakeWorkspace('d', ['f']),
    });
    assert.match(artifact.text, /строковый сбой/);
  });

  it('runExecution с fileWorkspace: нарушение инвариантов — жёсткий стоп (пробрасывается)', async t => {
    const run = planned(createRun('X', { idSuffix: 'inv' }));
    await assert.rejects(
      runExecution({
        run,
        makeConversation: makeConv(t, 'ответ'),
        writeArtifact: () => null,
        memoryContext: () => '',
        enforce: async () => {
          throw new InvariantViolationError(['нарушено']);
        },
        fileWorkspace: fakeWorkspace('diff', ['a']),
      }),
      err => err instanceof InvariantViolationError,
    );
  });

  it('runExecution с fileWorkspace: карта файлов проекта уходит в промпт исполнителя', async t => {
    const run = planned(createRun('Рефактор', { idSuffix: 'map' }));
    let prompt = '';
    await runExecution({
      run,
      makeConversation: makeConv(t, 'готово', p => (prompt = p)),
      writeArtifact: () => null,
      memoryContext: () => '',
      fileWorkspace: fakeWorkspace('', [], undefined, ['src/a.ts', 'src/b.ts', 'README.md']),
    });
    assert.match(prompt, /Файлы проекта.*read_files/s); // карта раскладки в промпте
    assert.match(prompt, /src\/a\.ts/);
    assert.match(prompt, /src\/b\.ts/);
  });

  it('runExecution с fileWorkspace: большая карта файлов усечена лимитом', async t => {
    const run = planned(createRun('Рефактор', { idSuffix: 'map2' }));
    let prompt = '';
    const many = Array.from({ length: 450 }, (unused, index) => `src/f${index}.ts`);
    await runExecution({
      run,
      makeConversation: makeConv(t, 'готово', p => (prompt = p)),
      writeArtifact: () => null,
      memoryContext: () => '',
      fileWorkspace: fakeWorkspace('', [], undefined, many),
    });
    assert.match(prompt, /показаны первые 400 из 450/);
  });

  it('runExecution с fileWorkspace без правок: помечает отсутствие изменений, резюме из ответа', async t => {
    const run = planned(createRun('Проверь', { idSuffix: 'fx0' }));
    const artifact = await runExecution({
      run,
      makeConversation: makeConv(t, 'Ничего менять не потребовалось'),
      writeArtifact: () => null,
      memoryContext: () => '',
      fileWorkspace: fakeWorkspace('   ', []), // diff из пробелов → «изменений нет»
    });

    assert.deepEqual(artifact.files, []);
    assert.match(artifact.text, /Изменений в файлах нет/);
    assert.match(artifact.summary, /Ничего менять не потребовалось/);
  });

  it('runExecution с fileWorkspace: пустой ответ и нет правок → пустое резюме', async t => {
    const run = planned(createRun('Пусто', { idSuffix: 'fxe' }));
    const artifact = await runExecution({
      run,
      makeConversation: makeConv(t, '   '), // ответ из пробелов, содержательной строки нет
      writeArtifact: () => null,
      memoryContext: () => '',
      fileWorkspace: fakeWorkspace('', []),
    });

    assert.equal(artifact.summary, ''); // нет ни файлов, ни содержательного ответа
    assert.match(artifact.text, /Изменений в файлах нет/);
  });

  it('runExecution с fileWorkspace: доработка по замечаниям правит файлы (не переделывает)', async t => {
    const run = planned(createRun('Исправь', { idSuffix: 'fxr' }));
    run.artifacts.verification = { passed: false, issues: ['нет раздела X'], text: '' };
    run.artifacts.execution = { summary: 'прошлый', files: ['a.md'], log: [], text: 'старый diff' };
    let prompt = '';
    await runExecution({
      run,
      makeConversation: makeConv(t, 'Добавил раздел X', p => (prompt = p)),
      writeArtifact: () => null,
      memoryContext: () => '',
      fileWorkspace: fakeWorkspace('--- a\n+++ b\n+X', ['a.md']),
    });

    assert.match(prompt, /Это ДОРАБОТКА/);
    assert.match(prompt, /правя\s+файлы/);
    assert.match(prompt, /нет раздела X/);
    assert.doesNotMatch(prompt, /Правка пользователя/); // correction нет
  });

  it('runExecution с fileWorkspace: правка пользователя без замечаний тоже включает доработку', async t => {
    const run = planned(createRun('Доработай', { idSuffix: 'fxc' }));
    run.correction = 'учти тёмную тему';
    let prompt = '';
    await runExecution({
      run,
      makeConversation: makeConv(t, 'Учёл', p => (prompt = p)),
      writeArtifact: () => null,
      memoryContext: () => '',
      fileWorkspace: fakeWorkspace('--- a\n+++ b\n+dark', ['theme.css']),
    });

    assert.match(prompt, /Это ДОРАБОТКА/);
    assert.match(prompt, /Правка пользователя: учти тёмную тему/);
    assert.doesNotMatch(prompt, /Замечания проверки/); // issues нет
  });

  it('runVerification с commandCheck: все команды пройдены → их результат в контексте судьи', async t => {
    const run = planned(createRun('Задача', { idSuffix: 'v1' }));
    run.artifacts.execution = { summary: 'r', files: ['a'], log: [], text: 'код' };
    const ran: string[] = [];
    let prompt = '';
    const verification = await runVerification({
      run,
      makeConversation: makeConv(t, '{"passed":true,"issues":[],"text":"ок"}', p => (prompt = p)),
      writeArtifact: () => null,
      memoryContext: () => '',
      commandCheck: checkWith({ test: 'npm test', build: 'npm run build', start: 'npm start' }, {}, ran),
    });

    // Прогнаны обнаруженные test/build (start исключён — он не завершается), в порядке kinds.
    assert.deepEqual(ran, ['npm test', 'npm run build']);
    assert.ok(verification.passed);
    assert.match(prompt, /Результаты команд проекта \(все пройдены/);
    assert.match(prompt, /npm test` → код 0/);
  });

  it('runVerification с commandCheck: провал команды → passed=false, модель не вызывается', async t => {
    const run = planned(createRun('Задача', { idSuffix: 'v2' }));
    run.artifacts.execution = { summary: 'r', files: [], log: [], text: 'код' };
    let modelCalled = false;
    const verification = await runVerification({
      run,
      makeConversation: () => {
        modelCalled = true;
        throw new Error('модель не должна вызываться при провале команды');
      },
      writeArtifact: () => null,
      memoryContext: () => '',
      commandCheck: checkWith({ test: 'npm test' }, { 'npm test': { code: 1, stderr: 'FAIL здесь' } }),
    });

    assert.equal(modelCalled, false);
    assert.equal(verification.passed, false);
    assert.match(verification.issues[0], /npm test` завершилась с кодом 1/);
    assert.match(verification.issues[0], /FAIL здесь/);
  });

  it('runVerification с commandCheck: таймаут команды → провал с пометкой и усечением вывода', async t => {
    const run = planned(createRun('Задача', { idSuffix: 'v3' }));
    run.artifacts.execution = { summary: 'r', files: [], log: [], text: 'код' };
    const verification = await runVerification({
      run,
      makeConversation: () => {
        throw new Error('не вызывается');
      },
      writeArtifact: () => null,
      memoryContext: () => '',
      commandCheck: checkWith(
        { lint: 'npm run lint' },
        { 'npm run lint': { code: 0, timedOut: true, stderr: 'ш'.repeat(2000) } },
      ),
    });

    assert.equal(verification.passed, false);
    assert.match(verification.issues[0], /прервана по таймауту/);
    assert.match(verification.issues[0], /^Команда `npm run lint`/);
    assert.ok(verification.issues[0].includes('…')); // длинный вывод усечён
  });

  it('runVerification с commandCheck без обнаруженных команд: обычная проверка моделью', async t => {
    const run = planned(createRun('Задача', { idSuffix: 'v4' }));
    run.artifacts.execution = { summary: 'r', files: [], log: [], text: 'код' };
    let prompt = '';
    const verification = await runVerification({
      run,
      makeConversation: makeConv(t, '{"passed":true,"issues":[],"text":"ок"}', p => (prompt = p)),
      writeArtifact: () => null,
      memoryContext: () => '',
      commandCheck: checkWith({}), // команд не обнаружено — запускать нечего
    });

    assert.ok(verification.passed);
    assert.doesNotMatch(prompt, /Результаты команд проекта/);
  });
});
