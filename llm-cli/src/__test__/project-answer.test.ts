import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProjectQuestion,
  projectAssistantDirective,
  parseCodePatterns,
  filesMatchingPatterns,
  filesFromHits,
  citationCandidates,
  forcedFileReads,
  collectGitContext,
  answerProjectQuestion,
  RAG_DONT_KNOW,
  RAG_UNVERIFIED,
} from '../index.ts';
import type { GenerationLimits, ProjectContext, ToolSet } from '../index.ts';
import type { Conversation } from '../../../core/src/index.ts';
import { clientWith, makeConfig } from '../../../core/src/__test__/helpers.ts';

const PROJECT: ProjectContext = {
  root: '/work/shop-api',
  name: 'shop-api',
  docSources: ['/work/shop-api/README.md'],
  commands: { test: 'npm test' },
};

/** Результат search_docs с одним фрагментом документации. */
const SEARCH_RESULT =
  '🔎 кандидатов 20 → rerank(mmr): 1 · уверенность 0.80\n' +
  '[1] README.md#1 · /work/shop-api/README.md › README.md › Аутентификация (0.80)\n' +
  'Авторизация выполняется по bearer-токену в заголовке Authorization.';

/** Набор инструментов: имена + ответы по имени; журнал вызовов. */
function toolSetWith(
  answers: Record<string, string | (() => string)>,
  calls: { name: string; args: Record<string, unknown> }[] = [],
): ToolSet {
  return {
    specs: () =>
      Object.keys(answers).map(name => ({
        name,
        description: '',
        parameters: { type: 'object' },
      })),
    call: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const answer = answers[name];
      return typeof answer === 'function' ? answer() : answer;
    },
  } as unknown as ToolSet;
}

const GIT_TOOLS = {
  git__git_branch: 'Репозиторий: /work/shop-api\nВетка: main',
  git__git_list_files: 'src/auth.ts\nsrc/orders.ts\nREADME.md',
  git__git_status: ' M src/auth.ts',
  git__git_grep: 'src/auth.ts:10:export function authorize(token: string): boolean {',
  git__read_file: 'export function authorize(token: string): boolean {\n  return token !== "";\n}',
  rag__search_docs: SEARCH_RESULT,
};

/** Ход просит модель назвать шаблоны для grep — узнаём этот вызов по ведущему system-промпту. */
function isCodePatternCall(messages: { role: string; content: string }[]): boolean {
  return (messages[0]?.content ?? '').includes('ПОИСКОВЫХ ШАБЛОНА');
}

/** Зависимости хода с подставленным клиентом. */
function deps(
  client: ReturnType<typeof clientWith>,
  tools: ToolSet,
  question = 'где обрабатывается авторизация?',
) {
  return {
    client,
    history: [{ role: 'user' as const, content: question }],
    question,
    projects: [PROJECT],
    tools,
    limits: {} as GenerationLimits,
    requestTimeoutMs: 1000,
    disableThinking: false,
    temperature: 0.2,
    onToolCall: () => {},
    onToolResult: () => {},
  };
}

describe('parseProjectQuestion', () => {
  it('вопрос вырезается из /ask', () => {
    assert.equal(parseProjectQuestion('/ask как устроен пайплайн?'), 'как устроен пайплайн?');
  });

  it('без вопроса и не /ask — null (идёт обычным путём)', () => {
    assert.equal(parseProjectQuestion('/ask'), null);
    assert.equal(parseProjectQuestion('/ask   '), null);
    assert.equal(parseProjectQuestion('обычная реплика'), null);
  });
});

describe('projectAssistantDirective', () => {
  it('называет проекты, запрещает выдумку и задаёт формат трёх секций', () => {
    const directive = projectAssistantDirective([PROJECT]);
    assert.match(directive, /shop-api/);
    assert.match(directive, /Не выдумывай пути/);
    assert.match(directive, /Цитаты:/);
  });
});

describe('parseCodePatterns', () => {
  it('снимает markdown-мусор и режет до трёх шаблонов', () => {
    const patterns = parseCodePatterns('- `authorize`\n2. AuthService,\nauth.ts\nlishnee\n');
    assert.deepEqual(patterns, ['authorize', 'AuthService', 'auth.ts']);
  });

  it('пересказ вопроса вместо идентификатора отбрасывается (для grep бесполезен)', () => {
    assert.deepEqual(parseCodePatterns('где именно в этом проекте обрабатывается авторизация'), []);
  });
});

describe('filesMatchingPatterns', () => {
  const paths = [
    'llm-cli/src/citation-guard.ts',
    'llm-cli/src/__test__/citation-guard.test.ts',
    'core/src/tokens.ts',
  ];

  it('шаблон-имя файла разрешается в реальные пути (иначе читались бы только упоминания)', () => {
    assert.deepEqual(filesMatchingPatterns(paths, ['citation-guard.ts']), [
      'llm-cli/src/citation-guard.ts',
    ]);
  });

  it('слишком короткий шаблон игнорируется, несовпадение — пусто', () => {
    assert.deepEqual(filesMatchingPatterns(paths, ['id']), []);
    assert.deepEqual(filesMatchingPatterns(paths, ['authorize']), []);
  });

  it('повторный шаблон не дублирует файл', () => {
    assert.deepEqual(filesMatchingPatterns(paths, ['tokens', 'tokens.ts']), ['core/src/tokens.ts']);
  });
});

describe('filesFromHits', () => {
  it('файлы из совпадений grep — уникальные, чаще встречающиеся раньше, не более трёх', () => {
    const hits = [
      {
        name: 'git__git_grep',
        args: { repo: '/work/api', pattern: 'authorize' },
        result: [
          'src/auth.ts:10:export function authorize(',
          'src/auth.ts:20:  authorize(token);',
          'src/routes.ts:5:import { authorize }',
          'нерелевантная строка без пути',
          'src/a.ts:1:x',
          'src/b.ts:1:x',
        ].join('\n'),
      },
    ];
    assert.deepEqual(filesFromHits(hits), [
      { repo: '/work/api', path: 'src/auth.ts' },
      { repo: '/work/api', path: 'src/routes.ts' },
      { repo: '/work/api', path: 'src/a.ts' },
    ]);
  });

  it('без repo в аргументах и без совпадений — пусто', () => {
    assert.deepEqual(
      filesFromHits([{ name: 'g', args: {}, result: 'Совпадений не найдено.' }]),
      [],
    );
  });
});

describe('citationCandidates', () => {
  const evidence = [
    {
      name: 'git__read_file',
      args: { path: 'src/auth.ts' },
      result: [
        'import { verify } from "./jwt.ts";',
        '',
        'export function authorize(token: string): boolean {',
        '  return verify(token);',
        '}',
      ].join('\n'),
    },
  ];

  it('готовые дословные строки с искомым шаблоном (их гейт и принимает)', () => {
    assert.deepEqual(citationCandidates(evidence, ['authorize']), [
      'export function authorize(token: string): boolean {',
    ]);
  });

  it('строки без шаблона и слишком короткие (`}`) не предлагаются', () => {
    assert.deepEqual(citationCandidates(evidence, ['verify']), [
      'import { verify } from "./jwt.ts";',
      'return verify(token);',
    ]);
    assert.deepEqual(citationCandidates(evidence, ['нетакого']), []);
  });

  it('кандидатов не больше пяти', () => {
    const many = [
      {
        name: 'git__read_file',
        args: { path: 'a.ts' },
        result: Array.from(
          { length: 9 },
          (_, index) => `export const value${index} = ${index};`,
        ).join('\n'),
      },
    ];
    assert.equal(citationCandidates(many, ['export const']).length, 5);
  });
});

describe('forcedFileReads', () => {
  it('нет инструмента чтения — файлы не читаются (и не выдумываются)', async () => {
    const read = await forcedFileReads(
      toolSetWith({ git__git_grep: 'x' }),
      [{ repo: '/work/api', path: 'src/auth.ts' }],
      () => {},
    );
    assert.deepEqual(read, []);
  });
});

describe('collectGitContext', () => {
  it('ветка и изменения по каждому проекту', async () => {
    const context = await collectGitContext(toolSetWith(GIT_TOOLS), [PROJECT]);
    assert.match(context, /shop-api:/);
    assert.match(context, /Ветка: main/);
    assert.match(context, /M src\/auth\.ts/);
  });

  it('нет git-инструментов — пусто (состояние не выдумываем)', async () => {
    const context = await collectGitContext(toolSetWith({ rag__search_docs: '' }), [PROJECT]);
    assert.equal(context, '');
  });
});

describe('answerProjectQuestion', () => {
  it('весь материал добывается ходом: доки → grep → чтение файла; модель только синтезирует', async t => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const tools = toolSetWith(GIT_TOOLS, calls);
    const client = clientWith(t, messages =>
      isCodePatternCall(messages)
        ? { content: 'authorize' }
        : {
            content: [
              'Ответ: авторизация — в src/auth.ts, функция authorize.',
              'Источники:',
              '- shop-api › src/auth.ts',
              'Цитаты:',
              '- «export function authorize(token: string): boolean»',
            ].join('\n'),
          },
    );

    const answer = await answerProjectQuestion(deps(client, tools));

    // Документация искалась принудительно — по источнику проекта, без надежды на инициативу модели.
    const search = calls.find(call => call.name === 'rag__search_docs');
    assert.deepEqual(search?.args.source, '/work/shop-api/README.md');
    // Git-контекст собран до генерации, а шаблоны grep выбирались по РЕАЛЬНОМУ списку файлов.
    assert.ok(calls.some(call => call.name === 'git__git_branch'));
    assert.ok(calls.some(call => call.name === 'git__git_list_files'));
    assert.deepEqual(
      calls.filter(call => call.name === 'git__git_grep').map(call => call.args.pattern),
      ['authorize'],
    );
    // Файл, на который указал grep, дочитан САМИМ ходом (не по инициативе модели).
    assert.deepEqual(
      calls.filter(call => call.name === 'git__read_file').map(call => call.args.path),
      ['src/auth.ts'],
    );
    assert.ok(answer.calledTools.includes('git__read_file'));
    assert.match(answer.content, /функция authorize/);
    assert.notEqual(answer.content, RAG_UNVERIFIED);
  });

  it('шаблон назвал ФАЙЛ — он читается целиком, даже если grep дал только упоминания', async t => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    // grep находит и сам файл, и его упоминание — файл не должен читаться дважды.
    const tools = toolSetWith(
      {
        ...GIT_TOOLS,
        git__git_grep: [
          'src/auth.ts:10:export function authorize(token: string): boolean {',
          'src/routes.ts:2:import { authorize } from "./auth.ts";',
        ].join('\n'),
      },
      calls,
    );
    const client = clientWith(t, messages =>
      isCodePatternCall(messages)
        ? { content: 'auth.ts' }
        : {
            content: [
              'Ответ: авторизация — в src/auth.ts.',
              'Источники:',
              '- src/auth.ts',
              'Цитаты:',
              '- «export function authorize(token: string): boolean»',
            ].join('\n'),
          },
    );

    const answer = await answerProjectQuestion(deps(client, tools));

    // Файл прочитан по ИМЕНИ из шаблона, а не только по совпадению grep.
    assert.deepEqual(
      calls.filter(call => call.name === 'git__read_file').map(call => call.args.path),
      ['src/auth.ts', 'src/routes.ts'],
    );
    assert.match(answer.content, /src\/auth\.ts/);
  });

  it('ответ по документации без чтения кода тоже проходит гейт', async t => {
    const tools = toolSetWith(GIT_TOOLS);
    const client = clientWith(t, messages =>
      isCodePatternCall(messages)
        ? { content: '' }
        : {
            content: [
              'Ответ: авторизация — по bearer-токену.',
              'Источники:',
              '- README.md#1',
              'Цитаты:',
              '- «Авторизация выполняется по bearer-токену в заголовке Authorization.»',
            ].join('\n'),
          },
    );

    const answer = await answerProjectQuestion(deps(client, tools));
    assert.match(answer.content, /bearer-токену/);
  });

  it('выдумка без доказательств заворачивается гейтом', async t => {
    const tools = toolSetWith(GIT_TOOLS);
    const client = clientWith(t, messages =>
      isCodePatternCall(messages)
        ? { content: '' }
        : {
            content: [
              'Ответ: авторизация в src/security/jwt.ts.',
              'Источники:',
              '- src/security/jwt.ts',
              'Цитаты:',
              '- «export class JwtGuard implements CanActivate»',
            ].join('\n'),
          },
    );

    const answer = await answerProjectQuestion(deps(client, tools));
    assert.equal(answer.content, RAG_UNVERIFIED);
  });

  it('о провале цитат сообщается наружу, а судья достоверности подключается, когда включён', async t => {
    const tools = toolSetWith(GIT_TOOLS);
    const failures: string[] = [];
    let round = 0;
    // Первый ответ — без секций (гейт забракует), второй — с дословной цитатой документации.
    const client = clientWith(t, messages => {
      if (isCodePatternCall(messages)) {
        return { content: '' };
      }
      round++;
      return {
        content:
          round === 1
            ? 'Авторизация где-то есть.'
            : [
                'Ответ: авторизация — по bearer-токену.',
                'Источники:',
                '- README.md#1',
                'Цитаты:',
                '- «Авторизация выполняется по bearer-токену в заголовке Authorization.»',
              ].join('\n'),
      };
    });

    const answer = await answerProjectQuestion({
      ...deps(client, tools),
      onCitationFailure: reason => failures.push(reason),
      // Судья достоверности: подтверждает ответ (проверяем, что ход его вызывает и принимает вердикт).
      faithfulness: {
        makeChecker: () => ({ ask: async () => ({ content: 'OK' }) }) as unknown as Conversation,
      },
    });

    assert.equal(failures.length, 1);
    assert.match(failures[0], /Источники/);
    assert.match(answer.content, /bearer-токену/);
  });

  it('нечего искать и нечего читать — «не знаю», а не выдумка', async t => {
    // Ни поиска по документации, ни инструментов кода: доказательств нет вовсе.
    const tools = toolSetWith({ git__git_branch: 'Ветка: main', git__git_status: '' });
    const client = clientWith(t, messages =>
      isCodePatternCall(messages) ? { content: '' } : { content: 'Ответ: наверное, где-то в src.' },
    );

    const answer = await answerProjectQuestion(deps(client, tools));
    assert.equal(answer.content, RAG_DONT_KNOW);
  });
});
