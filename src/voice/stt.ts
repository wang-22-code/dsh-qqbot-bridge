/**
 * 语音输入转写（STT）
 *
 * 支持两种后端：
 * - openai：OpenAI 兼容的 `POST {url}/audio/transcriptions`（multipart，返回 {text}）
 * - dsh：DSH 的 `ctx.speechToText` 服务（SenseVoice 等），具体适配见 createDshTranscriber
 *
 * 约定：调用方需把音频整理为 16kHz 单声道 PCM16 WAV 后再传入（DSH 语音服务要求）。
 */
import type { SttConfig } from '../config.js';

export interface AudioInput {
  filename: string;
  mime: string;
  data: Uint8Array;
}

export interface SttDeps {
  fetchImpl?: typeof fetch;
}

export interface SttHttpRequest {
  url: string;
  headers: Record<string, string>;
  form: FormData;
}

/** 构造 OpenAI 兼容转写请求（纯函数，便于单测） */
export function buildOpenAISttRequest(cfg: SttConfig, audio: AudioInput): SttHttpRequest {
  if (!cfg.url) throw new Error('STT 未配置服务地址：请设置 url（环境变量 STT_URL）');
  const form = new FormData();
  form.append('file', new Blob([audio.data as unknown as ArrayBuffer], { type: audio.mime || 'audio/wav' }), audio.filename || 'audio.wav');
  form.append('model', cfg.model || 'whisper-1');
  if (cfg.language) form.append('language', cfg.language);

  const url = `${cfg.url.replace(/\/+$/, '')}/audio/transcriptions`;
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  return { url, headers, form };
}

/** OpenAI 兼容转写（带超时） */
export async function transcribeOpenAI(
  cfg: SttConfig,
  audio: AudioInput,
  deps: SttDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('当前运行时不支持 fetch');
  const { url, headers, form } = buildOpenAISttRequest(cfg, audio);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs > 0 ? cfg.timeoutMs : 30000);
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body: form, signal: controller.signal });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      throw new Error(`STT 服务返回 HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const json = (await res.json()) as { text?: string };
    return (json.text ?? '').trim();
  } finally {
    clearTimeout(timer);
  }
}

/** DSH speechToText 服务的最小鸭子类型（真实签名以 dsh-experimental-speech-to-text 为准） */
export interface DshSpeechServiceLike {
  [key: string]: unknown;
}

export interface Transcriber {
  transcribe(audio: AudioInput): Promise<string>;
}

interface RealSpeechService {
  snapshot?: () => { providers?: Array<{ id: string; preparation?: { phase?: string; message?: string } }> };
  listProviders?: () => ReadonlyArray<{ id: string; languages?: readonly string[] }>;
  prepare?: (id: string, opts?: { downloadSource?: string }) => void | Promise<void>;
  resolve: (req: { audio: Uint8Array; providerId?: string; language?: string }) => unknown;
  transcribe: (spec: unknown, signal: AbortSignal) => Promise<{ text?: string }>;
}

/** 等待 SenseVoice 等本地 provider 完成准备（首次会下载模型；就绪后跳过） */
async function waitReady(svc: RealSpeechService, id: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const phase = svc.snapshot?.()?.providers?.find((p) => p.id === id)?.preparation?.phase;
    if (phase === 'ready' || phase === 'standby') return;
    if (phase === 'failed') {
      const msg = svc.snapshot?.()?.providers?.find((p) => p.id === id)?.preparation?.message ?? '';
      throw new Error(`STT 模型准备失败${msg ? `: ${msg}` : ''}`);
    }
    await new Promise<void>((r) => setTimeout(r, 1000));
  }
  throw new Error('STT 模型准备超时（可能仍在下载模型，请稍后重试）');
}

/** 基于 DSH speechToText 服务的转写器（SenseVoice 等） */
export function createDshTranscriber(
  service: DshSpeechServiceLike,
  providerId?: string,
  opts: { prepareTimeoutMs?: number; transcribeTimeoutMs?: number } = {},
): Transcriber {
  const svc = service as unknown as RealSpeechService;
  let prepared = false;

  return {
    async transcribe(audio: AudioInput): Promise<string> {
      const id = providerId ?? 'sensevoice-local';

      if (!prepared) {
        try {
          // prepare 可能是异步并返回 Promise；用 Promise.resolve 统一等待，
          // 避免其 reject 变成未处理的 Promise 拒绝。
          await Promise.resolve(svc.prepare?.(id));
        } catch {
          /* provider 可能已在准备或无需 prepare，忽略；就绪状态由 waitReady 判定 */
        }
        await waitReady(svc, id, opts.prepareTimeoutMs ?? 300_000);
        prepared = true;
      }

      const spec = svc.resolve({ audio: audio.data, providerId: id, language: 'auto' });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.transcribeTimeoutMs ?? 60_000);
      try {
        const { text } = await svc.transcribe(spec, controller.signal);
        return (text ?? '').trim();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface TranscribeOptions {
  deps?: SttDeps;
  /** DSH speechToText 服务（provider=dsh 时需要） */
  dsh?: DshSpeechServiceLike;
  /** DSH provider id（如 sensevoice-local） */
  dshProvider?: string;
}

/** 统一转写入口 */
export async function transcribe(
  cfg: SttConfig,
  audio: AudioInput,
  options: TranscribeOptions = {},
): Promise<string> {
  if (!cfg.enabled || cfg.provider === 'off') return '';
  if (cfg.provider === 'openai') return transcribeOpenAI(cfg, audio, options.deps ?? {});
  if (cfg.provider === 'dsh') {
    if (!options.dsh) throw new Error('DSH speechToText 服务不可用');
    return createDshTranscriber(options.dsh, options.dshProvider).transcribe(audio);
  }
  return '';
}
