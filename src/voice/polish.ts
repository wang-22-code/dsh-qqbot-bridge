/**
 * 语音后处理：把 TTS 原始 WAV 处理成更自然、且不易在转 SILK 时丢尾的语音。
 *
 * 管线：去内部长停顿 → 语速微调 → 响度归一化(-16 LUFS) → 开头补静音 → 结尾补静音 → 重采样 24kHz 单声道 PCM16。
 * 依赖 ffmpeg；找不到 ffmpeg 时原样返回，保证不阻断发送。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';

export interface PolishOptions {
  /** ffmpeg 可执行文件路径（留空自动探测） */
  ffmpegPath?: string;
  /** 语速（1=原速，0.9=放慢10%），默认 0.9 */
  tempo?: number;
  /** 开头静音(ms)，默认 200 */
  leadMs?: number;
  /** 结尾补静音(ms)，默认 350（防止 QQ 转 SILK 时吃掉尾音） */
  tailMs?: number;
}

const FFMPEG_CANDIDATES = [
  'C:/Program Files/File Converter/ffmpeg.exe',
  'C:/Users/user/AppData/Local/Programs/vidbee/resources/resources/ffmpeg/ffmpeg.exe',
];

/** 解析 ffmpeg 路径（配置优先，其次常见安装位置；都没有返回 undefined） */
export function resolveFfmpeg(configured?: string): string | undefined {
  if (configured && existsSync(configured)) return configured;
  for (const p of FFMPEG_CANDIDATES) if (existsSync(p)) return p;
  return undefined;
}

/** 构造后处理滤镜链（纯函数，便于单测） */
export function buildPolishFilter(tempo = 0.9, leadMs = 200, tailMs = 350): string {
  const t = tempo > 0 ? tempo : 1;
  const lead = Math.max(0, Math.round(leadMs));
  const tail = (Math.max(0, tailMs) / 1000).toFixed(3);
  return [
    'silenceremove=start_periods=1:start_duration=0.05:start_threshold=-45dB',
    'silenceremove=stop_periods=-1:stop_duration=0.15:stop_threshold=-40dB',
    `atempo=${t}`,
    'loudnorm=I=-16:TP=-1.5:LRA=11',
    `adelay=${lead}`,
    `apad=pad_dur=${tail}`,
    'aresample=24000',
  ].join(',');
}

/** 对一个 WAV 文件做后处理，返回处理后文件路径（失败则返回原路径，不抛错） */
export function polishWav(file: string, opts: PolishOptions = {}): string {
  const ff = resolveFfmpeg(opts.ffmpegPath);
  if (!ff) return file;
  try {
    if (!existsSync(file) || statSync(file).size < 44) return file;
    const head = readFileSync(file).subarray(0, 4);
    if (head.toString('ascii') !== 'RIFF') return file;
  } catch {
    return file;
  }
  const out = file.replace(/\.wav$/i, '') + '.polished.wav';
  const r = spawnSync(
    ff,
    ['-y', '-i', file, '-af', buildPolishFilter(opts.tempo, opts.leadMs, opts.tailMs), '-ac', '1', '-ar', '24000', '-sample_fmt', 's16', '-c:a', 'pcm_s16le', out],
    { stdio: 'ignore', timeout: 30000, killSignal: 'SIGKILL' },
  );
  if (r.error || r.signal || r.status !== 0 || !existsSync(out)) return file;
  try {
    rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
  return out;
}
