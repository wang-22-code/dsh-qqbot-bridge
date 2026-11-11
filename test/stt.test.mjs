import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenAISttRequest, transcribeOpenAI, transcribe } from '../dist/voice/stt.js';

function cfg(over = {}) {
  return {
    enabled: true,
    provider: 'openai',
    url: 'http://127.0.0.1:8000/v1',
    model: 'whisper-1',
    apiKey: 'k',
    language: 'zh',
    timeoutMs: 5000,
    ...over,
  };
}
const audio = { filename: 'a.wav', mime: 'audio/wav', data: new Uint8Array([1, 2, 3]) };

test('buildOpenAISttRequest builds url, auth, and multipart fields', () => {
  const req = buildOpenAISttRequest(cfg(), audio);
  assert.equal(req.url, 'http://127.0.0.1:8000/v1/audio/transcriptions');
  assert.equal(req.headers.authorization, 'Bearer k');
  assert.equal(req.form.get('model'), 'whisper-1');
  assert.equal(req.form.get('language'), 'zh');
  assert.ok(req.form.get('file'));
});

test('transcribeOpenAI returns text from response', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ text: ' 你好世界 ' }) });
  const text = await transcribeOpenAI(cfg(), audio, { fetchImpl: fakeFetch });
  assert.equal(text, '你好世界');
});

test('transcribeOpenAI throws with body on error', async () => {
  const fakeFetch = async () => ({ ok: false, status: 415, text: async () => 'bad format' });
  await assert.rejects(() => transcribeOpenAI(cfg(), audio, { fetchImpl: fakeFetch }), /HTTP 415.*bad format/);
});

test('transcribe dispatches by provider and returns empty when disabled', async () => {
  assert.equal(await transcribe(cfg({ enabled: false }), audio), '');
  assert.equal(await transcribe(cfg({ provider: 'off' }), audio), '');
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ text: 'ok' }) });
  assert.equal(await transcribe(cfg(), audio, { deps: { fetchImpl: fakeFetch } }), 'ok');
});
