/**
 * voice-diag.mjs — 情绪语音 TTS 链路诊断（只读诊断脚本，不改动 src）
 *
 * 目的：在与插件运行时一致的 VoiceConfig 下，调用 dist/voice/tts.js 的 synthesize()，
 * 分别在不同代理环境下判断 BreezeBlue 合成是否会挂起/失败。
 *
 * 用法：
 *   node test/voice-diag.mjs
 *
 * 环境变量（由外部 shell 控制，用于对比）：
 *   HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY / NODE_USE_ENV_PROXY
 *
 * 可选：
 *   VOICE_DIAG_TEXT      要合成的文本（默认「你好呀」）
 *   VOICE_DIAG_TIMEOUT   单次合成超时 ms（默认 15000）
 *   VOICE_DIAG_DISPATCHER  = dsh  → 额外用 undici ProxyAgent 复刻 DSH 的全局 dispatcher
 *   BREEZE_API_KEY / BREEZE_VOICE_ID  → 覆盖 .env（一般不设，脚本自动读 .env）
 *
 * 输出：成功/失败、WAV 字节数、耗时、错误类型/代码/原因链、出口路由。
 */
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(__dirname);

// ── 1. 读取项目根 .env（简易解析，与插件 env-loader 行为一致）─────────────────
function parseEnvContent(content) {
  const out = {};
  for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = (m[2] ?? '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

const envFile = join(PROJECT_ROOT, '.env');
if (!existsSync(envFile)) {
  console.error(`[voice-diag] 找不到 ${envFile}`);
  process.exit(2);
}
const dotenv = parseEnvContent(readFileSync(envFile, 'utf8'));

const apiKey = process.env.BREEZE_API_KEY || dotenv.BREEZE_API_KEY || '';
const voiceId = process.env.BREEZE_VOICE_ID || dotenv.BREEZE_VOICE_ID || '';

// ── 2. key 打码 ──────────────────────────────────────────────────────────────
function mask(s) {
  if (!s) return '<empty>';
  const str = String(s);
  if (str.length <= 8) return `****(len=${str.length})`;
  return `${str.slice(0, 4)}****${str.slice(-4)}(len=${str.length})`;
}

// ── 3. 构造与插件运行时一致的 VoiceConfig（src/config.ts 默认值 + .env 覆盖）────
const voiceCfg = {
  enabled: true,
  provider: 'breezeblue',
  emotional: (process.env.VOICE_EMOTIONAL ?? dotenv.VOICE_EMOTIONAL ?? 'true') !== 'false',
  apiKey,
  breezeUrl: process.env.BREEZE_URL || dotenv.BREEZE_URL || 'https://api.breeze.blue/v1',
  breezeModel: process.env.BREEZE_MODEL || dotenv.BREEZE_MODEL || 'breeze-tts-2',
  breezeVoice: voiceId,
  guidanceScale: 1.0,
  openaiUrl: 'https://api.openai.com/v1',
  openaiModel: 'tts-1',
  openaiVoice: 'alloy',
  localUrl: 'http://127.0.0.1:3900/v1',
  localModel: 'audiocpp',
  localVoice: '',
  maxChars: 1000,
};

// ── 4. 打印运行环境/出口路由 ──────────────────────────────────────────────────
function proxyEnvSnapshot() {
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY'];
  const o = {};
  for (const n of names) o[n] = process.env[n] ?? '<unset>';
  return o;
}

function currentDispatcherName() {
  try {
    // Node 内置 undici 与 npm undici 通过该 well-known symbol 共享全局 dispatcher
    const sym = Symbol.for('undici.globalDispatcher.1');
    const d = globalThis[sym];
    if (d && d.constructor) return d.constructor.name;
  } catch {
    /* ignore */
  }
  return '<unknown>';
}

const text = process.env.VOICE_DIAG_TEXT || '你好呀';
const timeoutMs = Number(process.env.VOICE_DIAG_TIMEOUT || 15000);
const dispatcherMode = (process.env.VOICE_DIAG_DISPATCHER || '').toLowerCase();

console.log('================ voice-diag ================');
console.log(`projectRoot  : ${PROJECT_ROOT}`);
console.log(`node         : ${process.version}`);
console.log(`API key      : ${mask(apiKey)}`);
console.log(`voiceId      : ${voiceId || '<empty>'}`);
console.log(`provider     : ${voiceCfg.provider}  model=${voiceCfg.breezeModel}  url=${voiceCfg.breezeUrl}`);
console.log(`text         : ${JSON.stringify(text)}  timeout=${timeoutMs}ms`);
console.log('proxy env    :');
for (const [k, v] of Object.entries(proxyEnvSnapshot())) console.log(`  ${k.padEnd(18)} = ${v}`);
console.log(`undici dispatcher (before): ${currentDispatcherName()}`);

// 可选：用 undici ProxyAgent 复刻 DSH dsh-http-proxy 的全局 dispatcher
if (dispatcherMode === 'dsh') {
  try {
    const proxyUrl =
      process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
    if (!proxyUrl) {
      console.warn('[voice-diag] dsh 模式但未设置代理，跳过 dispatcher 安装');
    } else {
      const undici = await import('undici');
      const { Agent, Pool, ProxyAgent, setGlobalDispatcher } = undici;
      // 复刻 dsh-http-proxy 的 createPolicyDispatcher：按 origin 决定是否走 ProxyAgent
      const agent = new Agent({
        factory(origin, options) {
          const u = new URL(origin.toString());
          const bypass = /^(localhost|127\.|::1|\[::1\])/.test(u.hostname);
          if (bypass) return new Pool(origin, options);
          return new ProxyAgent({ ...options, uri: proxyUrl });
        },
      });
      setGlobalDispatcher(agent);
      console.log(`undici dispatcher (after) : ${currentDispatcherName()}  proxy=${proxyUrl}`);
    }
  } catch (err) {
    console.warn(`[voice-diag] 安装 dsh dispatcher 失败（忽略）: ${err?.message || err}`);
  }
}

// ── 5. 调用真实 synthesize ───────────────────────────────────────────────────
const { synthesize, buildTtsRequest } = await import('../dist/voice/tts.js');

const started = Date.now();
let result = null;
let error = null;

try {
  // 传入 timeoutMs 与 retries:0，确保满足「15 秒超时」且单次尝试便于观察；
  // 外层再套一个硬性 Promise.race，保证即使 abort 未被底层兑现也不会永久挂起。
  const hardCap = timeoutMs + 1500;
  const run = synthesize(voiceCfg, text, '自然、亲切', { timeoutMs, retries: 0 });
  const raced = await Promise.race([
    run.then((r) => ({ ok: true, r })),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, hardTimeout: true }), hardCap)),
  ]);
  if (raced.hardTimeout) {
    throw Object.assign(new Error(`硬性超时 ${hardCap}ms（synthesize 未在 ${timeoutMs}ms 内兑现 AbortSignal）`), {
      name: 'HardTimeoutError',
      code: 'HARD_TIMEOUT',
    });
  }
  result = raced.r;
} catch (err) {
  error = err;
}

const elapsed = Date.now() - started;

// ── 6. 输出结论 ──────────────────────────────────────────────────────────────
console.log('--------------------------------------------');
if (result) {
  const buf = readFileSync(result.file);
  const magic = buf.subarray(0, 4).toString('latin1');
  const riffOk = magic === 'RIFF';
  console.log('RESULT   : SUCCESS');
  console.log(`  wavBytes : ${buf.length}`);
  console.log(`  wavMagic : ${JSON.stringify(magic)} (RIFF=${riffOk})`);
  console.log(`  elapsed  : ${elapsed}ms`);
  console.log(`  file     : ${result.file}`);
  // 清理临时文件
  try {
    rmSync(result.file, { force: true });
  } catch {
    /* ignore */
  }
} else {
  const name = error?.name || (error instanceof Error ? 'Error' : typeof error);
  const code = error?.code || error?.cause?.code || '<none>';
  const causeCode = error?.cause?.code || '<none>';
  const causeMsg = error?.cause?.message || '<none>';
  console.log('RESULT   : FAILURE');
  console.log(`  elapsed   : ${elapsed}ms`);
  console.log(`  errorType : ${name}`);
  console.log(`  code      : ${code}`);
  console.log(`  causeCode : ${causeCode}`);
  console.log(`  causeMsg  : ${causeMsg}`);
  console.log(`  message   : ${error?.message || String(error)}`);
  if (error?.stack) console.log(`  stack     : ${String(error.stack).split('\n').slice(0, 6).join('\n              ')}`);

  // 补充诊断：synthesize 只抛 "HTTP <status>"，这里用同一 buildTtsRequest 复现一次，
  // 打印服务端返回的状态+校验详情（不含 key），定位真实失败原因。
  try {
    const req = buildTtsRequest(voiceCfg, text, '自然、亲切');
    const res = await globalThis.fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
    });
    const ct = res.headers.get('content-type') || '';
    const raw = new Uint8Array(await res.arrayBuffer());
    const bodyText = ct.includes('audio')
      ? `<audio bytes=${raw.length} magic=${Buffer.from(raw.subarray(0, 4)).toString('latin1')}>`
      : Buffer.from(raw).toString('utf8').slice(0, 600);
    console.log(`  --- raw request detail (same buildTtsRequest) ---`);
    console.log(`  requestBodyKeys : ${Object.keys(req.body).join(', ')}`);
    console.log(`  requestUrl      : ${req.url}`);
    console.log(`  respStatus      : ${res.status}`);
    console.log(`  respContentType : ${ct || '<none>'}`);
    console.log(`  respBody        : ${bodyText}`);
  } catch (probeErr) {
    console.log(`  raw detail probe failed: ${probeErr?.message || probeErr}`);
  }
}
console.log('============================================');

process.exit(result ? 0 : 1);
