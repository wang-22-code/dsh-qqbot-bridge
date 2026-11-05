/**
 * SessionManager.getOrCreate 并发去重（TOCTOU 竞态）回归测试。
 * 不依赖真机/网络：用假的 ctx / agents registry。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '../dist/session/session-manager.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function fakeAgent(id) {
  return {
    id,
    ctx: {},
    session: { id },
    cancel() {},
    followup() {},
    whenIdle: async () => {},
  };
}

test('getOrCreate dedupes concurrent calls for the same peer (single resume)', async () => {
  const calls = { resume: 0, create: 0 };
  const agent = fakeAgent('agent-1');
  const agents = {
    get: () => undefined,
    async resume() {
      calls.resume += 1;
      await new Promise((r) => setTimeout(r, 15)); // 放大竞态窗口
      return { agent, dispose: async () => {} };
    },
    async create() {
      calls.create += 1;
      return { agent, dispose: async () => {} };
    },
  };
  const cfg = {
    cwd: process.cwd(),
    preset: undefined,
    provider: undefined,
    model: undefined,
    debug: false,
    sessionIdleTimeout: 0,
  };
  const ctx = { get: () => undefined };
  const mgr = new SessionManager(ctx, agents, cfg, silent);
  const target = { scope: 'c2c', targetId: 'peer-1' };

  const [r1, r2] = await Promise.all([
    mgr.getOrCreate('c2c', 'peer-1', 'sender-1', target),
    mgr.getOrCreate('c2c', 'peer-1', 'sender-1', target),
  ]);

  assert.equal(r1, r2, '并发调用应返回同一 record');
  assert.equal(calls.resume, 1, 'resume 只应调用一次');
});

test('getOrCreate returns a new record only after the in-flight one settles', async () => {
  const calls = { resume: 0 };
  const agent = fakeAgent('agent-2');
  const agents = {
    get: () => undefined,
    async resume() {
      calls.resume += 1;
      return { agent, dispose: async () => {} };
    },
    async create() {
      return { agent, dispose: async () => {} };
    },
  };
  const cfg = { cwd: process.cwd(), debug: false, sessionIdleTimeout: 0 };
  const mgr = new SessionManager({ get: () => undefined }, agents, cfg, silent);
  const target = { scope: 'c2c', targetId: 'peer-2' };

  const first = await mgr.getOrCreate('c2c', 'peer-2', 's', target);
  const second = await mgr.getOrCreate('c2c', 'peer-2', 's', { ...target, msgId: 'x' });
  assert.equal(first, second, '已存在时应复用同一 record');
  assert.equal(calls.resume, 1);
});
