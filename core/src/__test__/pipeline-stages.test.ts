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
import type { GenerationLimits, StageContext, TaskRun } from '../index.ts';
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

  it('parseExecution: JSON и фолбэк', () => {
    assert.deepEqual(parseExecution('{"summary":"s","log":["l"],"text":"t"}'), {
      summary: 's',
      log: ['l'],
      text: 't',
    });
    assert.equal(parseExecution('{"summary":"s"}').text, '{"summary":"s"}'); // text отсутствует → контент
    const fb = parseExecution('первая строка\nвторая');
    assert.equal(fb.summary, 'первая строка');
    assert.deepEqual(fb.log, []);
    assert.equal(fb.text, 'первая строка\nвторая');
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

  it('runPlanning и runExecution подмешивают память задачи в промпт', async t => {
    const run = createRun('Сайт');
    run.artifacts.planning = { steps: ['s'], criteria: ['c'], text: 'план' };
    let planPrompt = '';
    await runPlanning(
      ctxWith(
        t,
        '{"steps":[],"criteria":[],"text":""}',
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
        '{"summary":"готово","log":[],"text":"КОД"}',
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
    assert.deepEqual(written, [{ name: 'execution-1.md', content: 'КОД' }]);
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

  it('runVerification: пустые критерии → провал без вызова модели', async t => {
    let called = false;
    // (а) план вообще не сформирован
    const noPlan = createRun('Пустая');
    const v1 = await runVerification(ctxWith(t, '{"passed":true}', noPlan, () => (called = true)));
    assert.equal(v1.passed, false);
    assert.match(v1.issues[0], /Критерии приёмки не сформулированы/);

    // (б) план есть, но критериев нет
    const emptyCriteria = createRun('Пустая');
    emptyCriteria.artifacts.planning = { steps: ['s'], criteria: [], text: 'план' };
    const v2 = await runVerification(ctxWith(t, '{"passed":true}', emptyCriteria));
    assert.equal(v2.passed, false);

    assert.equal(called, false); // в обоих случаях модель не звали
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
