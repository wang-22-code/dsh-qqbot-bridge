/**
 * OneBot 语音媒体：把收到的 record 语音取回并转成 16kHz 单声道 PCM16 WAV。
 *
 * 关键事实：QQ PTT 语音是 SILK v3，ffmpeg 不能直接解。先用 NapCat 的
 * `get_record(out_format:"wav")` 让网关转码，再用 ffmpeg 归一化采样率/声道。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OneBotApi } from './api.js';

export interface VoiceAudio {
  data: Uint8Array;
  filename: string;
  mime: string;
}

const FFMPEG_CANDIDATES = [
  'C:/Program Files/File Converter/ffmpeg.exe',
  'C:/Users/user/AppData/Local/Programs/vidbee/resources/resources/ffmpeg/ffmpeg.exe',
];

/** 解析 ffmpeg 路径（配置优先，其次常见安装位置；都没有返回 undefined） */
export function resolveFfmpeg(configured?: string): string | undefined {
  if (configured && existsSync(configured)) return configured;
  for (const p of FFMPEG_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

export interface FetchVoiceOptions {
  ffmpegPath?: string;
  fetchImpl?: typeof fetch;
  tmpDir?: string;
}

/**
 * 从 record 消息段取音频并转 16k mono pcm16 WAV。
 * recordData 为 OneBot record 段的 data（含 file 编码 id / path / url）。
 */
export async function fetchVoiceAudio(
  api: OneBotApi,
  recordData: Record<string, unknown>,
  opts: FetchVoiceOptions = {},
): Promise<VoiceAudio> {
  const fileId = String(recordData.file ?? recordData.file_id ?? '');
  if (!fileId) throw new Error('record 缺少 file id');

  const rec = await api.getRecord(fileId, 'wav');
  const dir = mkdtempSync(join(opts.tmpDir ?? tmpdir(), 'dsh-voice-'));
  try {
    let inputPath: string;
    if (rec.file && existsSync(rec.file)) {
      inputPath = rec.file;
    } else if (rec.url) {
      const res = await (opts.fetchImpl ?? globalThis.fetch)(rec.url);
      if (!res.ok) throw new Error(`下载语音失败 HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      inputPath = join(dir, 'in.wav');
      writeFileSync(inputPath, Buffer.from(buf));
    } else if (rec.base64) {
      const b64 = rec.base64.replace(/^base64:\/\//, '');
      inputPath = join(dir, 'in.wav');
      writeFileSync(inputPath, Buffer.from(b64, 'base64'));
    } else {
      throw new Error('get_record 未返回可读取的音频');
    }

    const outPath = join(dir, 'out16k.wav');
    const ffmpeg = resolveFfmpeg(opts.ffmpegPath);
    if (ffmpeg) {
      // 加超时与强制结束：spawnSync 是同步阻塞，若 ffmpeg 卡住会冻结整个事件循环
      const r = spawnSync(
        ffmpeg,
        ['-y', '-i', inputPath, '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', '-c:a', 'pcm_s16le', outPath],
        { stdio: 'ignore', timeout: 30000, killSignal: 'SIGKILL' },
      );
      if (r.error || r.signal || r.status !== 0 || !existsSync(outPath)) {
        throw new Error('ffmpeg 转码到 16k mono pcm16 失败');
      }
    } else {
      // 没有 ffmpeg：假定网关已返回可用 wav（可能采样率不符，但先降级尝试）
      writeFileSync(outPath, readFileSync(inputPath));
    }

    return { data: new Uint8Array(readFileSync(outPath)), filename: 'voice.wav', mime: 'audio/wav' };
  } finally {
    // 清理本次创建的临时目录（涵盖所有错误路径），避免每条语音消息泄漏一个目录
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
