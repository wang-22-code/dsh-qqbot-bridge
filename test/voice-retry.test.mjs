import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synthesize } from '../dist/voice/index.js';

function cfg() {
  return {
    enabled: true,
    provider: 'breezeblue',
    emotional: true,
    apiKey: 'k',
    breezeUrl: 'https://api.breeze.blue/v1',
    breezeModel: 'breeze-tts-2',
    breezeVoice: 'voc_x',
    guidanceScale: 1.0,
    openaiUrl: 'https://api.openai.com/v1',
    openaiModel: 'tts-1',
    openaiVoice: 'alloy',
    localUrl: 'http://127.0.0.1:3900/v1',
    localModel: 'audiocpp',
    localVoice: 'v',
    maxChars: 1000,
  };
}

test('synthesize retries on transient failure then succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tts-retry-'));
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls < 2) return { ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    };
    const res = await synthesize(cfg(), '你好', '自然', { fetchImpl, tmpDir: dir, retries: 2 });
    assert.equal(calls, 2);
    assert.ok(existsSync(res.file));
    assert.equal(statSync(res.file).size, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthesize gives up after exhausting retries', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  await assert.rejects(
    () => synthesize(cfg(), 'x', '自然', { fetchImpl, retries: 1 }),
    /HTTP 500/,
  );
  assert.equal(calls, 2); // 1 次 + 1 次重试
});
