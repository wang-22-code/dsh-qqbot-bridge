import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pollNapCatLogin } from '../dist/transport/onebot/index.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

function fakeQrFetch() {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { qrcode: Buffer.from([137, 80, 78, 71]).toString('base64') } }),
  });
}

test('pollNapCatLogin stops once logged in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'napcat-poll-'));
  try {
    let checks = 0;
    const res = await pollNapCatLogin({
      webuiUrl: 'http://127.0.0.1:6099',
      token: 't',
      logger: silent,
      fetchImpl: fakeQrFetch(),
      outDir: dir,
      intervalMs: 5,
      timeoutMs: 3000,
      isLoggedIn: async () => {
        checks += 1;
        return checks >= 2; // 第 2 次检查视为已登录
      },
    });
    assert.equal(res.ok, true);
    assert.match(res.message, /已登录/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pollNapCatLogin times out when never logged in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'napcat-poll2-'));
  try {
    const res = await pollNapCatLogin({
      webuiUrl: 'http://127.0.0.1:6099',
      logger: silent,
      fetchImpl: fakeQrFetch(),
      outDir: dir,
      intervalMs: 5,
      timeoutMs: 40,
      isLoggedIn: async () => false,
    });
    assert.equal(res.ok, false);
    assert.match(res.message, /超时|中止/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
