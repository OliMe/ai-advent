import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  Conversation,
  parseTeamPlan,
  orchestrateTeam,
  runRoleExperts,
  mapWithConcurrency,
} from '../index.ts';
import type { AgentRole } from '../index.ts';
import { clientWith } from './helpers.ts';

/** Фабрика диалога: отдаёт `reply(system)`; пробрасывает температуру роли. */
function factory(t: TestContext, reply: (system: string) => string | Promise<string>) {
  return (system: string, _limits?: unknown, temperature?: number) => {
    const client = clientWith(t, async () => ({ content: await reply(system), usage: undefined }));
    return new Conversation(client, {
      systemPrompt: system,
      temperature: temperature ?? 0.7,
      contextTokens: 8192,
      requestTimeoutMs: 5000,
    });
  };
}

describe('parseTeamPlan', () => {
  it('разбирает роли с температурой и обоснованием, зажимает по лимиту', () => {
    const team = parseTeamPlan(
      '{"roles":[{"name":"архитектор","focus":"структура","temperature":0.2},' +
        '{"name":"безопасность","focus":"риски"},{"name":"лишний","focus":"x"}],' +
        '"rationale":"сложная система"}',
      2,
    );
    assert.equal(team.roles.length, 2); // третья роль отброшена лимитом
    assert.deepEqual(team.roles[0], { name: 'архитектор', focus: 'структура', temperature: 0.2 });
    assert.deepEqual(team.roles[1], { name: 'безопасность', focus: 'риски' }); // без температуры
    assert.equal(team.rationale, 'сложная система');
  });

  it('отбрасывает некорректные роли и нечисловую температуру', () => {
    const team = parseTeamPlan(
      '{"roles":[{"name":"a","focus":"f"},{"name":"","focus":"нет имени"},"строка",' +
        '{"focus":"без имени"},{"name":"b","temperature":"горячо"}]}',
      5,
    );
    assert.deepEqual(team.roles, [
      { name: 'a', focus: 'f' },
      { name: 'b', focus: '' }, // focus по умолчанию пуст, кривая температура отброшена
    ]);
    assert.equal(team.rationale, ''); // rationale отсутствует → пусто
  });

  it('мусор/без ролей → одиночная универсальная роль', () => {
    for (const raw of ['не json', '{"roles":[]}', '{"roles":"строка"}']) {
      const team = parseTeamPlan(raw, 4);
      assert.equal(team.roles.length, 1);
      assert.equal(team.roles[0]?.name, 'универсальный');
      assert.equal(team.rationale, '');
    }
  });
});

describe('orchestrateTeam', () => {
  it('лимит ≤ 1 → одиночная роль без обращения к модели', async t => {
    let called = false;
    const team = await orchestrateTeam({
      makeConversation: factory(t, () => {
        called = true;
        return '{}';
      }),
      task: 'Задача',
      context: '',
      stageLabel: 'планирование',
      maxAgents: 1,
    });
    assert.equal(called, false); // оркестратор не вызван
    assert.equal(team.roles.length, 1);
    assert.match(team.rationale, /выключена/);
  });

  it('подбирает команду по ответу модели (с контекстом и без)', async t => {
    for (const context of ['', 'ПАМЯТЬ']) {
      const team = await orchestrateTeam({
        makeConversation: factory(
          t,
          () => '{"roles":[{"name":"архитектор","focus":"структура"}],"rationale":"r"}',
        ),
        task: 'Сложная система',
        context,
        stageLabel: 'планирование',
        maxAgents: 3,
      });
      assert.deepEqual(team.roles, [{ name: 'архитектор', focus: 'структура' }]);
    }
  });

  it('сбой оркестратора → одиночная роль', async t => {
    const team = await orchestrateTeam({
      makeConversation: factory(t, () => {
        throw new Error('оркестратор упал');
      }),
      task: 'Задача',
      context: '',
      stageLabel: 'планирование',
      maxAgents: 4,
    });
    assert.equal(team.roles.length, 1);
    assert.match(team.rationale, /недоступен/);
  });
});

describe('mapWithConcurrency', () => {
  it('сохраняет порядок результатов', async () => {
    const result = await mapWithConcurrency([1, 2, 3], 2, async value => value * 10);
    assert.deepEqual(result, [10, 20, 30]);
  });

  it('лимит больше длины и пустой вход', async () => {
    assert.deepEqual(await mapWithConcurrency([5], 5, async v => v + 1), [6]);
    assert.deepEqual(await mapWithConcurrency([], 3, async v => v), []);
  });

  it('не запускает больше лимита одновременно', async () => {
    let active = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    let done = false;
    const promise = mapWithConcurrency([0, 1, 2, 3, 4], 2, async value => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>(resolve => gates.push(resolve));
      active--;
      return value;
    }).then(result => {
      done = true;
      return result;
    });
    // По одному освобождаем «ворота» на каждом тике, пока веер не завершится.
    while (!done) {
      await new Promise(resolve => setImmediate(resolve));
      gates.shift()?.();
    }
    assert.equal(peak, 2); // одновременно не больше лимита
    assert.deepEqual(await promise, [0, 1, 2, 3, 4]);
  });
});

describe('runRoleExperts', () => {
  const roles: AgentRole[] = [
    { name: 'архитектор', focus: 'структура', temperature: 0.2 },
    { name: 'безопасность', focus: 'риски' },
  ];

  it('собирает вклады ролей, пробрасывает системный промпт и температуру', async t => {
    const systems: string[] = [];
    const contributions = await runRoleExperts({
      roles,
      makeConversation: factory(t, system => {
        systems.push(system);
        return `вклад: ${system}`;
      }),
      buildSystem: role => role.name,
      buildPrompt: role => `задание для ${role.name}`,
      concurrency: 2,
    });
    assert.deepEqual(
      contributions.map(contribution => contribution.role),
      ['архитектор', 'безопасность'],
    );
    assert.equal(contributions[0]?.text, 'вклад: архитектор');
    assert.deepEqual(systems.sort(), ['архитектор', 'безопасность']);
  });

  it('пробрасывает инструменты каждой роли (эксперты читают проект сами)', async t => {
    const seenTools: unknown[] = [];
    const tools = {
      specs: () => [],
      call: async () => '',
    };
    const makeConversation = (
      system: string,
      _limits?: unknown,
      temperature?: number,
      passedTools?: unknown,
    ) => {
      seenTools.push(passedTools);
      const client = clientWith(t, async () => ({ content: 'ок', usage: undefined }));
      return new Conversation(client, {
        systemPrompt: system,
        temperature: temperature ?? 0.7,
        contextTokens: 8192,
        requestTimeoutMs: 5000,
      });
    };
    await runRoleExperts({
      roles,
      makeConversation,
      buildSystem: role => role.name,
      buildPrompt: () => 'задание',
      concurrency: 2,
      tools,
    });
    assert.deepEqual(seenTools, [tools, tools]); // обе роли получили инструменты
  });

  it('сбой роли пропускается с уведомлением, остальные идут', async t => {
    const failures: string[] = [];
    const contributions = await runRoleExperts({
      roles,
      makeConversation: factory(t, system => {
        if (system === 'архитектор') {
          throw new Error('роль упала');
        }
        return 'ок';
      }),
      buildSystem: role => role.name,
      buildPrompt: () => 'задание',
      concurrency: 2,
      onError: role => failures.push(role.name),
    });
    assert.deepEqual(failures, ['архитектор']);
    assert.deepEqual(
      contributions.map(contribution => contribution.role),
      ['безопасность'],
    );
  });
});
