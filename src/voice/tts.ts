/**
 * 情绪语音 TTS 链路
 *
 * 支持三类服务（与参考项目一致）：
 * - breezeblue：BreezeBlue 官方 API（POST /v1/text-to-speech/{voice_id}?output_format=wav&delivery=sync）
 * - openai：OpenAI 兼容（POST /v1/audio/speech）
 * - local：本地 VoiceStudio(audiocpp)（POST /v1/audio/speech，可带 instructions 情绪）
 *
 * 情绪表达：由 detectEmotion 做轻量语气判断，作为 instructions 传给支持的服务。
 * 设计为可注入 fetch/写文件，便于单测（不依赖真实网络）。
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { VoiceConfig } from '../config.js';

export interface TtsHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface TtsResult {
  file: string;
}

export interface TtsDeps {
  fetchImpl?: typeof fetch;
  tmpDir?: string;
}

const EMOTION_RULES: Array<{ re: RegExp; hint: string }> = [
  { re: /(开心|高兴|哈哈|太好了|棒|耶)/, hint: '开心、轻快' },
  { re: /(难过|伤心|呜呜|委屈|失落)/, hint: '低落、温柔' },
  { re: /(生气|讨厌|哼|气死|烦)/, hint: '有点小脾气，但依然亲近' },
  { re: /(害羞|不好意思|脸红|害羞)/, hint: '害羞、轻柔' },
  { re: /(安慰|别怕|抱抱|没事的)/, hint: '温柔、安慰' },
  { re: /(惊讶|真的吗|哇)/, hint: '惊讶、明亮' },
];

/** 轻量语气判断：命中关键词给出情绪描述，否则自然亲切 */
export function detectEmotion(text: string): string {
  for (const rule of EMOTION_RULES) {
    if (rule.re.test(text)) return rule.hint;
  }
  return '自然、亲切';
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** 构造某个 provider 的 TTS HTTP 请求（纯函数，便于单测） */
export function buildTtsRequest(
  cfg: VoiceConfig,
  text: string,
  emotion: string,
): TtsHttpRequest {
  const instructions = cfg.emotional ? emotion : '';

  if (cfg.provider === 'breezeblue') {
    const voice = encodeURIComponent(cfg.breezeVoice);
    return {
      url: `${trimSlash(cfg.breezeUrl)}/text-to-speech/${voice}?output_format=wav&delivery=sync`,
      headers: {
        'content-type': 'application/json',
        'xi-api-key': cfg.apiKey,
      },
      body: {
        text,
        model_id: cfg.breezeModel,
        voice_id: cfg.breezeVoice,
        ...(instructions ? { instructions } : {}),
        voice_settings: { guidance_scale: cfg.guidanceScale },
      },
    };
  }

  if (cfg.provider === 'openai') {
    return {
      url: `${trimSlash(cfg.openaiUrl)}/audio/speech`,
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: {
        model: cfg.openaiModel,
        voice: cfg.openaiVoice,
        input: text,
        response_format: 'wav',
        ...(instructions ? { instructions } : {}),
      },
    };
  }

  // local (VoiceStudio / audiocpp)
  return {
    url: `${trimSlash(cfg.localUrl)}/audio/speech`,
    headers: {
      'content-type': 'application/json',
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: {
      model: cfg.localModel,
      voice: cfg.localVoice,
      input: text,
      response_format: 'wav',
      ...(instructions ? { instructions } : {}),
    },
  };
}

/**
 * 合成语音，返回本地临时 WAV 文件路径。
 * 供 OneBot 以 record 段发送，或桌面端播放。
 */
export async function synthesize(
  cfg: VoiceConfig,
  text: string,
  emotion: string,
  deps: TtsDeps = {},
): Promise<TtsResult> {
  if (cfg.provider === 'off') throw new Error('语音未启用');
  const clean = text.trim().slice(0, Math.max(1, cfg.maxChars));
  if (!clean) throw new Error('待合成文本为空');

  const req = buildTtsRequest(cfg, clean, emotion);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('当前运行时不支持 fetch');

  const res = await fetchImpl(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
  });
  if (!res.ok) throw new Error(`TTS 服务返回 HTTP ${res.status}`);

  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length === 0) throw new Error('TTS 返回空音频');

  const dir = deps.tmpDir ?? tmpdir();
  const file = join(dir, `dsh-tts-${randomUUID()}.wav`);
  writeFileSync(file, buf);
  return { file };
}
