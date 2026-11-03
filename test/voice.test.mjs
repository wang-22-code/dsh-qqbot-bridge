import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectEmotion, buildTtsRequest, synthesize } from '../dist/voice/index.js';

function baseVoice(overrides = {}) {
  return {
    enabled: true,
    provider: 'breezeblue',
    emotional: true,
    apiKey: 'test-key',
    breezeUrl: 'https://api.breeze.blue/v1',
    breezeModel: 'breeze-tts-2',
    breezeVoice: 'voice-abc',
    guidanceScale: 1.2,
    openaiUrl: 'https://api.openai.com/v1',
    openaiModel: 'tts-1',
    openaiVoice: 'alloy',
    localUrl: 'http://127.0.0.1:3900/v1',
    localModel: 'audiocpp',
    localVoice: 'v1',
    maxChars: 1000,
    ...overrides,
  };
}

test('detectEmotion maps keywords and falls back to natural', () => {
  assert.match(detectEmotion('太好了，我好开心'), /开心/);
  assert.match(detectEmotion('呜呜好难过'), /低落/);
  assert.match(detectEmotion('哼，讨厌'), /脾气/);
  assert.match(detectEmotion('今天天气不错'), /自然/);
});

test('buildTtsRequest for breezeblue uses official endpoint, headers and guidance', () => {
  const req = buildTtsRequest(baseVoice(), '你好', '开心、轻快');
  assert.match(req.url, /\/text-to-speech\/voice-abc\?output_format=wav&delivery=sync$/);
  assert.equal(req.headers['xi-api-key'], 'test-key');
  assert.equal(req.body.model_id, 'breeze-tts-2');
  assert.equal(req.body.voice_id, 'voice-abc');
  assert.equal(req.body.instructions, '开心、轻快');
  assert.deepEqual(req.body.voice_settings, { guidance_scale: 1.2 });
});

test('buildTtsRequest for openai and local use /audio/speech', () => {
  const oa = buildTtsRequest(baseVoice({ provider: 'openai' }), 'hi', '自然');
  assert.match(oa.url, /\/audio\/speech$/);
  assert.equal(oa.headers.authorization, 'Bearer test-key');
  assert.equal(oa.body.model, 'tts-1');
  assert.equal(oa.body.voice, 'alloy');

  const local = buildTtsRequest(baseVoice({ provider: 'local' }), 'hi', '自然');
  assert.match(local.url, /3900\/v1\/audio\/speech$/);
  assert.equal(local.body.model, 'audiocpp');
  assert.equal(local.body.instructions, '自然');
});

test('buildTtsRequest omits instructions when emotional disabled', () => {
  const req = buildTtsRequest(baseVoice({ emotional: false }), 'hi', '开心');
  assert.equal('instructions' in req.body, false);
});

test('synthesize writes returned bytes to a wav file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tts-'));
  try {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([82, 73, 70, 70]).buffer,
    });
    const res = await synthesize(baseVoice(), '你好呀', '自然', {
      fetchImpl: fakeFetch,
      tmpDir: dir,
    });
    assert.equal(existsSync(res.file), true);
    assert.equal(statSync(res.file).size, 4);
    assert.match(res.file, /\.wav$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('synthesize throws on HTTP error and on disabled provider', async () => {
  const failing = async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) });
  await assert.rejects(() => synthesize(baseVoice(), 'x', '自然', { fetchImpl: failing }), /HTTP 500/);
  await assert.rejects(() => synthesize(baseVoice({ provider: 'off' }), 'x', '自然'), /语音未启用/);
});
