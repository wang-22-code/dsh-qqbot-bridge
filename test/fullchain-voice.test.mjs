/**
 * 全链路（语音）集成测试 —— 不依赖真机/真实网络。
 *
 * 覆盖：record 段 -> api.get_record 取回本地文件 -> ffmpeg 归一化(16k mono pcm16，
 * 无 ffmpeg 时降级拷贝) -> 构造 OpenAI 兼容 /audio/transcriptions 请求 -> 解析转写文本。
 *
 * 说明：transport 侧的 WebSocket 全链路（握手/事件/action/sender）已由
 * onebot-server.test.mjs 覆盖；本文件补齐「语音媒体 + STT」这一段链路。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchVoiceAudio } from '../dist/transport/onebot/media.js';
import { transcribe } from '../dist/voice/stt.js';

/** 生成一段合法的 16kHz 单声道 PCM16 WAV（静音） */
function makeWav(seconds = 0.05, sampleRate = 16000) {
  const n = Math.max(1, Math.floor(sampleRate * seconds));
  const dataLen = n * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

test('full chain: get_record file -> normalize -> OpenAI STT transcribe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fullchain-'));
  try {
    const wavPath = join(dir, 'in.wav');
    writeFileSync(wavPath, makeWav());

    // 1) 模拟 OneBot api.get_record 返回本地文件
    const fakeApi = {
      async getRecord(_file, _fmt) {
        return { file: wavPath };
      },
    };
    // 2) 取回并归一化为 16k mono pcm16 WAV（有 ffmpeg 用 ffmpeg，没有则降级拷贝）
    const audio = await fetchVoiceAudio(fakeApi, { file: 'voice-id' }, { tmpDir: dir });
    assert.equal(audio.mime, 'audio/wav');
    assert.ok(audio.data.length > 44, '应有 WAV 数据');
    assert.equal(
      String.fromCharCode(audio.data[0], audio.data[1], audio.data[2], audio.data[3]),
      'RIFF',
      '输出应为 RIFF/WAVE',
    );

    // 3) OpenAI 兼容 STT 转写（用注入的 fetch，避免真实网络）
    const cfg = {
      enabled: true,
      provider: 'openai',
      url: 'http://127.0.0.1:9/v1',
      model: 'FunAudioLLM/SenseVoiceSmall',
      apiKey: 'k',
      language: 'zh',
      timeoutMs: 2000,
      ffmpegPath: '',
    };
    let seenUrl = '';
    const fakeFetch = async (url) => {
      seenUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ text: ' 你好世界 ' }) };
    };
    const text = await transcribe(cfg, audio, { deps: { fetchImpl: fakeFetch } });
    assert.equal(seenUrl, 'http://127.0.0.1:9/v1/audio/transcriptions');
    assert.equal(text, '你好世界');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchVoiceAudio cleans up its temp dir on error paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fullchain-err-'));
  try {
    // get_record 无 file/url/base64 -> 抛错
    const apiNoAudio = { async getRecord() { return {}; } };
    await assert.rejects(() => fetchVoiceAudio(apiNoAudio, { file: 'x' }, { tmpDir: dir }));
    // url 下载失败 -> 抛错
    const apiBadUrl = { async getRecord() { return { url: 'http://127.0.0.1:9/x.wav' }; } };
    const failingFetch = async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) });
    await assert.rejects(() =>
      fetchVoiceAudio(apiBadUrl, { file: 'x' }, { tmpDir: dir, fetchImpl: failingFetch }),
    );
    // 两种错误路径都不应残留 dsh-voice-* 临时目录
    const leftover = readdirSync(dir).filter((n) => n.startsWith('dsh-voice-'));
    assert.deepEqual(leftover, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
