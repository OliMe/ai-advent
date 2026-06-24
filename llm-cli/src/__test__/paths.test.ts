import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionDirectory,
  profilePath,
  tasksDirectory,
  profilesDirectory,
  mcpConfigPath,
} from '../index.ts';

describe('sessionDirectory', () => {
  it('берёт каталог из LLM_SESSION_DIR, иначе ~/.llm-cli/sessions', () => {
    const saved = process.env.LLM_SESSION_DIR;
    try {
      process.env.LLM_SESSION_DIR = '/tmp/custom-sessions';
      assert.equal(sessionDirectory(), '/tmp/custom-sessions');
      delete process.env.LLM_SESSION_DIR;
      assert.match(sessionDirectory(), /[/\\]\.llm-cli[/\\]sessions$/);
    } finally {
      if (saved === undefined) delete process.env.LLM_SESSION_DIR;
      else process.env.LLM_SESSION_DIR = saved;
    }
  });

  it('profilePath, tasksDirectory и profilesDirectory лежат рядом с каталогом сессий', () => {
    const saved = process.env.LLM_SESSION_DIR;
    try {
      process.env.LLM_SESSION_DIR = '/tmp/base/sessions';
      assert.equal(profilePath(), '/tmp/base/profile.json');
      assert.equal(tasksDirectory(), '/tmp/base/tasks');
      assert.equal(profilesDirectory(), '/tmp/base/profiles');
      assert.equal(mcpConfigPath(), '/tmp/base/mcp.json');
    } finally {
      if (saved === undefined) delete process.env.LLM_SESSION_DIR;
      else process.env.LLM_SESSION_DIR = saved;
    }
  });
});
