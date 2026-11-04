# DSH 语音识别（STT）接口研究笔记

> 只读研究结论，供在自定义 Cordis 插件（`dsh-qqbot-bridge`）里调用 `ctx.speechToText` 并在 `qqbot-safe-dev` profile 挂载本地 SenseVoice。
> 调研对象：DSH 安装目录 `C:\Users\user\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`，版本 `0.2.1-rc.5`。
> 运行时事实：本会话实际运行的 DSH 是全局 npm 安装（`...\npm\node_modules\@deepseek-ai\dsh\lib\bin.js`），`DSH_HOME=C:\Users\user\.dsh`，`DSH_PROFILE=web`；另有 `--profile qqbot-safe-dev` 的进程在跑。

---

## 0. TL;DR

- 服务名：`ctx.speechToText`（`SpeechToText` 类，`Service`）。挂载包：`@deepseek-ai/dsh-experimental-speech-to-text`。
- 调用模型是 **两段式**：`resolve(request) -> SpeechSpec`，再 `transcribe(spec, signal) -> Transcript`。没有"一次到位"的 transcribe 重载。
- `transcribe()` **必须传 `AbortSignal`**（第二参数，必填）。
- 音频必须是 **16 kHz、单声道、PCM16 的标准 WAV**（44 字节 `RIFF/WAVE/fmt /data` 头），否则被 provider 拒绝。
- SenseVoice 本地 provider：`@deepseek-ai/dsh-experimental-speech-to-text-sensevoice`，默认 id `sensevoice-local`，`dataRoot` 必填且**必须是绝对路径**。
- 首次使用需**显式 `prepare(providerId)`** 才会下载模型（激活时只 `inspect()` 缓存，不下载、不加载）。缓存就绪时激活即进入 `standby`，无需 prepare 就能转写。
- 依赖：**profile 的 node_modules 里没有**这些包，但 DSH 安装级（installation scope）**已经自带**（含 `sherpa-onnx-node@1.13.8` + `sherpa-onnx-win-x64` 原生库），运行时可解析、无需 pnpm 安装。唯一需要额外处理的是 **TS 编译期类型**（见 §4）。
- 最大风险：模型下载（~239 MB int8）走 huggingface / hf-mirror，可能被网络墙；以及 `language` 传空串会被 `resolve()` 拒绝。

---

## 1. 服务接口（`ctx.speechToText`）

### 1.1 挂载与暴露名

`@deepseek-ai/dsh-experimental-speech-to-text/lib/types/index.d.ts`：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Experimental speech recognition provider registry. */
    speechToText: SpeechToText;
  }
}
export default class SpeechToText extends Service { ... }
```

- 运行时通过 Cordis 服务注册为 `speechToText`，插件里可用 `ctx.speechToText`（类型经上面的 module augmentation 增强）或 `ctx.get('speechToText')`（等价，返回实例）。
- 该服务本身**不产生**下载/模型行为；它只是"具名 provider 注册表 + 路由"。

### 1.2 确切方法签名（逐字来自 `index.d.ts`）

```ts
/** Registered provider selected when the caller omits an id. */
defaultProvider: Volatile<string>;   // Config 字段：required（无默认，必须配置）
language: Volatile<string>;          // Config 字段：default "auto"

register(provider: SpeechProvider): () => Promise<void>;      // provider 注册（一般不用手动调）
listProviders(): readonly SpeechProviderInfo[];               // 可用 provider 列表（不含准备状态）
snapshot(): SpeechSnapshot;                                   // 一次完整观测：providers(含准备状态) + selection
follow(caller: AbortSignal): AsyncIterable<SpeechSnapshot>;   // 观察准备状态变化（初值 + 后续）
configure(patch: SpeechSelectionPatch): Promise<void>;         // 持久化选择（需 settings 服务 + profile entry）
prepare(id: SpeechProviderId, options?: SpeechPreparationOptions): void;   // 触发/加入准备（下载+校验+加载），同步返回 void
cancelPreparation(id: SpeechProviderId): Promise<void>;       // 取消准备
resolve(request: SpeechRequest): SpeechSpec;                  // 按默认值解析并锁定 provider
transcribe(spec: SpeechSpec, signal: AbortSignal): Promise<Transcript>;  // 执行（无跨 provider 回退）
```

### 1.3 相关类型（`lib/types/types.d.ts`，逐字）

```ts
/** 转写输入（provider 层）：WAV 字节 + 语言提示 */
export interface SpeechInput {
  readonly audio: Uint8Array;
  readonly language: string;
}
/** 最终转写结果；text === '' 表示未识别到语音 */
export interface Transcript {
  readonly text: string;
  readonly audioSeconds: number;
  readonly inferenceSeconds: number;
}
/** 调用方请求（未定默认值）：录音 + 可选 provider/语言 */
export interface SpeechRequest {
  readonly audio: Uint8Array;
  readonly providerId?: SpeechProviderId;
  readonly language?: string;
}
/** 解析结果：锁定到具体 provider 实例 */
export interface SpeechSpec extends SpeechInput {
  readonly provider: SpeechProvider;
}
export interface SpeechProviderInfo {
  readonly id: SpeechProviderId;
  readonly name: string;
  readonly location: 'host-local' | 'cloud';
  readonly languages: readonly string[];
  readonly setupEstimate?: SpeechSetupEstimate;    // { recommendedDiskBytes, expectedMemoryBytes, minimumMinutes, maximumMinutes }
  readonly downloadSources?: readonly string[];    // 可供 prepare 选择的下载源（origin）
}
export interface SpeechProviderView extends SpeechProviderInfo {
  readonly preparation: SpeechPreparationState;    // 当前准备状态
}
export interface SpeechSnapshot {
  readonly providers: readonly SpeechProviderView[];
  readonly selection: SpeechSelection;             // { providerId, language }
}
export type SpeechPreparationState =
  | { phase: 'unprepared' | 'ready' | 'standby' | 'cancelled' }
  | { phase: 'downloading'; resource: string; completedBytes: number; totalBytes?: number }
  | { phase: 'checking' | 'loading' | 'waking' | 'cancelling'; startedAt: number }
  | { phase: 'failed'; message: string; download?: SpeechDownloadFailure };
export interface SpeechPreparationOptions { readonly downloadSource?: string; }
```

> `SpeechProviderId` 是 branded string（`Branded<'SpeechProviderId'>`）。TS 里传普通字符串需 `as SpeechProviderId`；纯 JS 无影响。

### 1.4 `resolve()` / `transcribe()` 的准确语义（`lib/index.js`）

```js
resolve(request) {
  const id = request.providerId ?? this.config.defaultProvider.get();
  const language = request.language ?? this.config.language.get();
  return { provider: this.selectedProvider(id, language), audio: request.audio, language };
}
async transcribe(spec, signal) {
  signal.throwIfAborted();
  const registration = this.providers.get(spec.provider.info.id);
  if (registration?.provider !== spec.provider) throw new Error('Resolved speech provider is no longer registered');
  const combined = AbortSignal.any([signal, registration.lifetime.signal]);
  return await spec.provider.transcribe({ audio: spec.audio, language: spec.language }, combined);
}
```

要点：

- `resolve()` **只做选择**：确定 provider 与 language，**不校验 WAV**、不读磁盘。
- `selectedProvider()` 会校验 `providerId` 已注册、且 `language ∈ provider.info.languages`；否则抛 `Speech provider is unavailable: <id>` / `Speech provider <id> does not support language: <lang>`。
- **`language` 不能传空串**：SenseVoice 的 `languages = ['auto','zh','en','yue','ja','ko']`，`''` 不在其中 → 直接报错。要么不传（走 config 默认 `'auto'`），要么传上述之一。
- `transcribe()` 的 `signal` 是**必填**（`signal.throwIfAborted()` 立刻解引用）。它把调用方的 signal 与 provider 注册生命周期的 signal 合并（`AbortSignal.any`），因此 provider 卸载也会取消进行中的转写。
- 不存在跨 provider 回退：`resolve()` 锁定的 provider 失效或被替换会抛错，不会把音频发给别人。
- `transcribe()` 只是转发到 `spec.provider.transcribe(input, combined)`；WAV 合法性由 provider（SenseVoice）在内部校验。

### 1.5 取消 / AbortSignal

- 取消单次转写：给 `transcribe(spec, signal)` 的 `signal` 传一个会 abort 的 `AbortController.signal`。
- 取消准备（下载/加载）：`await ctx.speechToText.cancelPreparation(providerId)`。
- provider 卸载/服务 dispose 会合并取消所有在途任务（`registration.lifetime` / `service.lifetime`）。
- 注意：`follow(caller)` 的 signal 只控制"观察"结束，**不会**取消准备任务（README 明确）。

### 1.6 可直接照抄的 TypeScript 调用示例（基于真实 d.ts）

```ts
import type { Context } from '@deepseek-ai/cordis';
import type SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text';
import type {
  SpeechSpec,
  Transcript,
  SpeechProviderView,
  SpeechProviderId,
} from '@deepseek-ai/dsh-experimental-speech-to-text';

/**
 * 用 DSH speechToText 服务转写一段 WAV。
 * @param wav   规范 16kHz 单声道 PCM16 WAV 的字节（Uint8Array，含 44 字节头）
 * @param lang  'auto' | 'zh' | 'en' | 'yue' | 'ja' | 'ko'；空串/undefined 时走 config 默认 'auto'
 */
export async function transcribeWav(
  ctx: Context,
  wav: Uint8Array,
  lang: string | undefined = 'auto',
  providerId?: string,          // 如 'sensevoice-local'
  signal?: AbortSignal,
): Promise<Transcript> {
  // 插件里：要么在元数据声明 inject: ['speechToText']，要么用 ctx.get 惰性取。
  const speech = (ctx.get('speechToText') ?? (ctx as any).speechToText) as SpeechToText | undefined;
  if (!speech) throw new Error('speechToText 服务未挂载（profile 未启用 speech-to-text 插件）');

  const id = (providerId ?? speech.snapshot().selection.providerId) as SpeechProviderId;

  // 1) 确保资源就绪：首次需 prepare（下载+校验+加载）；缓存命中时激活已处于 standby。
  const view = (): SpeechProviderView | undefined =>
    speech.snapshot().providers.find((p) => p.id === id);
  const phase0 = view()?.preparation.phase;
  if (phase0 === 'unprepared' || phase0 === 'failed' || phase0 === 'cancelled') {
    const ac = new AbortController();
    const onAbort = () => ac.abort((signal as any)?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      speech.prepare(id); // 同步返回，下载/加载在 Host 后台进行
      for await (const snap of speech.follow(ac.signal)) {
        const st = snap.providers.find((p) => p.id === id)?.preparation;
        if (!st) break;
        if (st.phase === 'ready' || st.phase === 'standby') break;   // 两种都可转写
        if (st.phase === 'failed') throw new Error(`准备失败: ${(st as any).message ?? 'unknown'}`);
        if (st.phase === 'cancelled') throw new Error('准备被取消');
        // downloading / checking / loading / waking：继续等
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // 2) 解析（锁定 provider）。注意 language 传 undefined 才会走 config 默认，别传 ''。
  const spec: SpeechSpec = speech.resolve({
    audio: wav,
    providerId: id,
    language: lang && lang.length > 0 ? lang : undefined,
  });

  // 3) 执行（signal 必填）
  const caller = signal ?? new AbortController().signal;
  return await speech.transcribe(spec, caller);
}
```

**缓存已就绪时的最短路径**（standby/ready 下）：

```ts
const spec = ctx.speechToText.resolve({ audio: wav, providerId: 'sensevoice-local' as SpeechProviderId });
const { text } = await ctx.speechToText.transcribe(spec, abortController.signal);
```

**读取可用 provider 列表 / 准备状态**：

```ts
for (const p of ctx.speechToText.listProviders()) {
  console.log(p.id, p.name, p.location, p.languages, p.downloadSources);
}
const snap = ctx.speechToText.snapshot();
// snap.selection === { providerId, language }
// snap.providers[i].preparation.phase === 'ready' | 'standby' | 'unprepared' | 'downloading' | ...
```

---

## 2. 音频格式要求

**一句话规格：必须是 16 kHz、单声道、16-bit（PCM16）的规范 WAV（标准 44 字节头）。**

`@deepseek-ai/dsh-experimental-speech-to-text/lib/types/wave.d.ts` / `wave.js` 的 `validateWave()` 精确校验（任一不符即抛 `Audio must be a canonical 16 kHz mono PCM16 WAV recording`）：

| 偏移 | 字段 | 要求 |
|---|---|---|
| 0..4 | `RIFF` | 必须是 `RIFF` |
| 8..12 | `WAVE` | 必须是 `WAVE` |
| 12..16 | `fmt ` | 必须是 `fmt ` |
| 16 | fmt 块长度 | `16` |
| 20 | audioFormat | `1`（PCM） |
| 22 | numChannels | `1`（单声道） |
| 24 | sampleRate | `16000` |
| 28 | byteRate | `32000` |
| 32 | blockAlign | `2` |
| 34 | bitsPerSample | `16` |
| 36..40 | `data` | 必须是 `data` |
| 4 | RIFF chunk size | `len - 8` |
| 40 | data chunk size | `len - 44`，(len-44) 必须为偶数 |
| — | 最小长度 | ≥ 46 字节 |

附加限制（SenseVoice provider）：

- `maxAudioBytes` 默认 `4 * 1024 * 1024`（4 MiB）。按 32000 B/s 计算，**约 131 秒**上限。超限记 `SpeechInputError`（不触发 worker 重启）。
- provider 侧 `validateInput(audio, language, maxAudioBytes)` 会先做 WAV 校验与语言校验，再进原生推理。
- 若改用 `dsh-experimental-api-speech-to-text` 的 Remote（base64 上传），外层还有 `maxAudioBytes` / `maxDurationSeconds` 两道上限（见该包 Config）。

生成方式（若源音频不是该格式）：

```bash
ffmpeg -i input.ogg -ac 1 -ar 16000 -sample_fmt s16 -c:a pcm_s16le out.wav
```

---

## 3. SenseVoice 挂载（profile 的 `cordis.patch.yml`）

### 3.1 两个插件的职责

| 插件包 | 作用 | 关键 config |
|---|---|---|
| `@deepseek-ai/dsh-experimental-speech-to-text` | 提供 `ctx.speechToText` 服务（provider 注册表 + 路由） | `defaultProvider`（必填）、`language`（默认 `auto`） |
| `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` | 注册本地 SenseVoice provider（`inject = ['speechToText','subprocess']`） | `providerId`（默认 `sensevoice-local`）、`dataRoot`（必填，绝对路径）、`precision`（默认 `int8`）等 |

> 挂载顺序无所谓：Cordis 依赖注入（`inject`）会自动保证 `speechToText` 先就绪。

### 3.2 推荐写法 A（最小挂载：只加两条 entry）

把下面内容**追加**到 `C:\Users\user\.dsh\profiles\qqbot-safe-dev\cordis.patch.yml`（该文件是"顶层 YAML 数组"，每条 `- id: ... name: ... config:` 形式新增一个 entry——本 profile 里 `llm-pi-ai` 已经是这个用法，可用）：

```yaml
# ── DSH 语音识别：服务 + 本地 SenseVoice provider ──
- id: speech-to-text
  name: '@deepseek-ai/dsh-experimental-speech-to-text'
  config:
    defaultProvider: sensevoice-local # 必须等于下面 provider 的 providerId
    language: auto                    # 可选；默认 auto

- id: speech-to-text-sensevoice
  name: '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice'
  config:
    providerId: sensevoice-local
    # 必填，绝对路径。!!js 表达式在本 profile 的 patch 层可用
    # （loader 用 `with (ctx) { eval(expr) }` 求值，且 ctx.provide('dshHomePath', dshHomePath)）
    dataRoot: !!js dshHomePath('speech-to-text', 'sensevoice')
    precision: int8                   # int8（默认，约 239MB）| fp32（约 938MB）
    modelOrigins:                     # 默认即这两项；显式写出便于阅读
      - https://huggingface.co
      - https://hf-mirror.com
```

`dataRoot: !!js dshHomePath('speech-to-text', 'sensevoice')` 会解析为：

```
C:\Users\user\.dsh\speech-to-text\sensevoice
```

不想用 `!!js` 的话，等价地写死绝对路径（**必须绝对**，否则 provider 激活即抛 `SenseVoice paths must be absolute`）：

```yaml
    dataRoot: 'C:/Users/user/.dsh/speech-to-text/sensevoice'
```

> 本 profile 已确认支持 `!!js`：现有 `cordis.patch.yml` 里 `c2cAllow` 就用了 `!!js >- ...`。

### 3.3 写法 B（整包启用：加 voice-input-bundle）

若希望"一键"带齐（服务 + SenseVoice + Remote API + 浏览器麦克风 UI），把 `@deepseek-ai/dsh-experimental-voice-input-bundle` 加进 profile 的 `dsh.profile.bundles`（`~/.dsh/profiles/qqbot-safe-dev/package.json`）即可；它自带的 `cordis.patch.yml` 会 insert 四条：

```yaml
- insert:
    - id: speech-to-text
      name: '@deepseek-ai/dsh-experimental-speech-to-text'
      config:
        defaultProvider: sensevoice-local
    - id: speech-to-text-sensevoice
      name: '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice'
      config:
        dataRoot: !!js dshHomePath('speech-to-text', 'sensevoice')
    - id: api-speech-to-text
      name: '@deepseek-ai/dsh-experimental-api-speech-to-text'
    - id: ui-voice-input
      name: '@deepseek-ai/dsh-experimental-client-ui-voice-input'
```

> 对 QQ 机器人（无 Web UI）场景，写法 A 更干净：不需要 Remote API 与浏览器 UI 两行。

### 3.4 SenseVoice 全部 config 字段与默认值（`lib/types/config.d.ts` + `lib/index.js`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `providerId` | `"sensevoice-local"` | 注册 id，消费者按此选择 |
| `dataRoot` | **必填**（绝对路径） | 校验通过的 ONNX 模型缓存根目录 |
| `modelDirectory` | —（可选） | 已存在的模型目录（含所选 ONNX + `tokens.txt`），给了就不下载模型 |
| `vadModelPath` | —（可选） | 已存在的 Silero VAD ONNX，给了就不下载 VAD |
| `precision` | `"int8"` | `int8` / `fp32` |
| `modelOrigin` | —（可选） | 显式唯一源；给后**不探测、不回退**公共源 |
| `modelOrigins` | `["https://huggingface.co","https://hf-mirror.com"]` | 下载前并发 HEAD 探测，先返回 2xx 的优先 |
| `modelProbeTimeoutMs` | `3000` | HEAD 探测超时 |
| `threads` | `2` | CPU intra-op 线程 |
| `segmentSeconds` | `30` | 单段最长秒数（1..120） |
| `vadThreshold` | `0.5` | Silero 语音概率阈值 |
| `minSpeechSeconds` | `0.25` | VAD 最短语音 |
| `minSilenceSeconds` | `0.5` | 两段语音间静音 |
| `vadOnsetPaddingSeconds` | `0.3` | 起音回填（冷启动检测器迟报） |
| `maxAudioBytes` | `4194304`（4 MiB） | 单次录音字节上限（≈131s） |
| `prepareTimeoutMs` | `3600000`（1h） | 准备/冷加载总超时（够下载） |
| `inferenceTimeoutMs` | `120000` | 单次推理超时 |
| `idleTimeoutMs` | `300000` | 空闲多久停 worker；0=常驻 |
| `maxPending` | `4` | 最大排队转写数 |
| `graceMs` | `1000` | 进程终止宽限 |
| `maxLogBytes` | `65536` | worker 诊断日志上限 |
| `maxResponseBytes` | `131072` | 转写响应上限 |
| `progressIntervalMs` | `100` | 下载进度通知最小间隔 |

### 3.5 模型下载（大小 / 来源 / 固定 revision）

来自 `runtime/assets.json`（release 固定，全部校验 `bytes` + `sha256`）：

| 文件 | 大小 | 上游 URL | sha256 |
|---|---|---|---|
| `model.int8.onnx` | **239,233,841 B（≈228 MiB）** | `huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx` | `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51` |
| `model.onnx`（fp32） | **937,617,178 B（≈894 MiB）** | 同仓库 `/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.onnx` | `977016bd9c79f9eb343430b5cc305e07ab64d5212dff41b0dcfa1694bee9a8cb` |
| `tokens.txt` | 315,894 B | 同仓库 `/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt` | `f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc` |
| `silero_vad.onnx` | 1,807,522 B（≈1.7 MiB） | `huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx` | `a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28` |

- 固定 revision：模型/词表 `2365baeacb507f821a0c8120fcee3d484dba7a07`；VAD `fba88cd2e921609e7675c3aaf51e0b9b295da4bc`。
- 来源顺序：`modelOrigins`（默认 huggingface.co → hf-mirror.com），每个缺失文件下载前并发 HEAD 探测、先 2xx 优先；网络/HTTP/证书/校验失败会换下一个源，取消/存储错误/未知错误停止。
- `setupEstimate.recommendedDiskBytes`：int8 记 1e9、fp32 记 2e9（**规划估算**，非实际体积；实际见上表）。
- 首次下载总量（int8）：约 239 MB + 0.3 MB + 1.7 MB ≈ **241 MB**。

**缓存目录布局**（`dataRoot = C:\Users\user\.dsh\speech-to-text\sensevoice`）：

```
<dataRoot>\models\sensevoice-onnx\model.int8.onnx
<dataRoot>\models\sensevoice-onnx\tokens.txt
<dataRoot>\models\silero\silero_vad.onnx
```

### 3.6 `prepare()` 是否必须、如何触发下载

- **激活时** `apply()` 只调 `worker.inspect()`：只检查磁盘缓存（存在 + 大小/哈希匹配）→ `standby`；否则 `unprepared`。**激活不下载、不加载模型**。
- **首次使用必须显式准备**：`ctx.speechToText.prepare(providerId)`（或 `provider.preparation.prepare()`）。它同步返回、后台执行 `check → (model) → (vad) → verify → load → ready`。
- 转写准入（`execute()` 逐字）：
  ```js
  const phase = this.state.phase;
  if (phase !== 'ready' && phase !== 'standby') throw new Error('Prepare the local speech provider before recording');
  ```
  即：**`ready` 或 `standby`（缓存已就绪）才能转写；`unprepared` 直接抛错，且不会触发下载**。
- 等待就绪：用 `follow(signal)` 迭代 `SpeechSnapshot`，看到 `preparation.phase` 变 `ready`/`standby` 即可；`failed` 时读 `preparation.message` / `preparation.download`。
- 也可在 UI 里显式选源：`prepare(id, { downloadSource: 'https://hf-mirror.com' })`。
- 取消：`cancelPreparation(id)`。
- 缓存跨插件禁用/重启保留；已完成校验的文件在失败/取消后可复用（只补缺失文件）。

### 3.7 已知坑

1. **原生依赖**：SenseVoice 依赖 `sherpa-onnx-node@1.13.8`（其 `optionalDependencies` 带各平台原生包，Windows 是 `sherpa-onnx-win-x64`，内含 `sherpa-onnx.node`、`onnxruntime.dll` 等）。DSH 安装包已一并装好（README 明确："安装 dsh 时会一并安装 `sherpa-onnx-node` 及其平台原生运行时（含 ONNX Runtime），即使此 Bundle 处于禁用状态"）。**见 §4 实测**。
2. **平台**：仅 `darwin-arm64 / darwin-x64 / linux-arm64 / linux-x64 / win32-x64`。**Windows ARM64 与 Linux musl 不支持**（`apply` 前 `resolveRuntime` 会抛 `Local speech is unavailable for win32-arm64`）。当前机器是 win32-x64 → OK。
3. **下载被墙**：默认第二个源就是 `hf-mirror.com`；国内可直接用 `modelOrigin: https://hf-mirror.com`（只此源、不探测不回退）或 `prepare(id, { downloadSource })`。注意 `modelOrigin/modelOrigins` 会被规范化成 origin（只保留 scheme+host）。
4. **`dataRoot` 必须是绝对路径**；相对路径激活即抛错。
5. **语言提示**：`languages = auto/zh/en/yue/ja/ko`。传 `''` 会被 `resolve()` 拒绝；省缺省则用 config `language`（默认 `auto`）。
6. **纯 CPU**：无 GPU；`threads` 默认 2，模型内存 > 文件大小且随录音长度增长。
7. **空结果**：`Transcript.text === ''` 表示未识别到语音（不是错误）。
8. **`maxPending` 默认 4**：超过抛 `Speech transcription queue is full`。
9. **`configure()` 依赖 settings 服务 + profile entry**：只持久化"用户选择"，不持久化"下载源"。插件里调用 `resolve`/`transcribe`/`prepare` **不需要** settings；无需调 `configure`。

---

## 4. 依赖是否已安装（关键结论）

### 4.1 实测目录事实

| 位置 | 是否含 STT 包 / sherpa | 说明 |
|---|---|---|
| `~/.dsh/profiles/qqbot-safe-dev/node_modules` | **否** | 只有 `dsh-qqbot-bridge`（junction → `D:\dsh-qqbot-bridge`）、`@tencent-connect`、`.pnpm` 等 |
| `~/.dsh/profiles/node_modules`（共享 hoisted，201 个 `@deepseek-ai`） | **否** | 且 **201 个全是 junction，196 个指向已消失的 `D:\deepseek-harness`** → 实际是失效链接（stale） |
| `C:\Users\user\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai` | **是** | 含 `dsh-experimental-speech-to-text`、`-sensevoice`、`-api-speech-to-text`、`-voice-input-bundle`、`-client-ui-voice-input` |
| 同上 `...\dsh\node_modules\sherpa-onnx-node`（1.13.8） | **是** | 含 `sherpa-onnx.js` 等 |
| 同上 `...\dsh\node_modules\sherpa-onnx-win-x64`（1.13.8） | **是** | 含 `sherpa-onnx.node`、`onnxruntime.dll`、`sherpa-onnx-c-api.dll` 等 |

### 4.2 为什么"profile 里没有"却仍能用：two-anchor 解析

`@deepseek-ai/dsh-app-boot/lib/index.js`（`collectInstallationScopePackages` / `createRuntimeResolution`）实现"两锚点"模块解析，源码注释原文：

> "Module resolution is two-anchor by construction: a bundle name resolves [from the installation] … profile directory. Pnpm-managed entries in the profile's `node_modules` resolve first. **The runtime resolution supplies packages carried by the installation and selected bundles to Node's ESM and CommonJS resolvers.**"

`collectInstallationScopePackages` 会从安装锚点（`dsh` 包的 `package.json`）出发，**递归遍历 `dependencies` + `peerDependencies` 依赖闭包**，把这些包提供给所有 profile。`dsh` 包直接依赖 `@deepseek-ai/dsh-experimental-voice-input-bundle`，后者又依赖 speech-to-text / sensevoice / api / client-ui → 因此这些包（以及 `sherpa-onnx-node`）都在 **installation scope**。

**实测验证**（Node 解析，只读）：

```
createRequire('...\dsh\lib\bin.js'):
  @deepseek-ai/dsh-experimental-speech-to-text            => 解析成功
  @deepseek-ai/dsh-experimental-speech-to-text-sensevoice => 解析成功
  @deepseek-ai/dsh-experimental-api-speech-to-text        => 解析成功
  @deepseek-ai/dsh-experimental-voice-input-bundle        => 解析成功
  sherpa-onnx-node                                        => 解析成功
  sherpa-onnx-win-x64                                     => 解析成功
```

（同时 `@deepseek-ai/dsh-base` 也只能从安装级解析 —— 而 `--profile qqbot-safe-dev` 进程正在正常运行，反证安装级解析生效、profile 里的失效 junction 不影响。）

### 4.3 结论与动作

- **运行时：不需要把 STT 包加进 profile 的 `node_modules` / `dependencies`**。直接在 profile 的 `cordis.patch.yml` 写 `name: '@deepseek-ai/dsh-experimental-speech-to-text'` 即可，`sherpa-onnx` 原生库也已随 dsh 装好。
- 如果希望 profile **自己拥有/锁定版本**（可选）：把这两个包加入 `~/.dsh/profiles/qqbot-safe-dev/package.json` 的 `dependencies` 并 `pnpm install`，或改用 §3.3 的 bundles 写法。
- **唯一需要补的是 TS 编译期类型**：`D:\dsh-qqbot-bridge\node_modules` 里**没有** `@deepseek-ai/dsh-experimental-speech-to-text`（实测 `MODULE_NOT_FOUND`）。因此若要在 `src/voice/stt.ts` 里 `import type` 真实类型：
  - 方案一（推荐）：`pnpm add -D @deepseek-ai/dsh-experimental-speech-to-text@0.2.1-rc.5`（仅类型需要；运行时仍走 installation scope）。
  - 方案二：保持当前**鸭子类型**（`DshSpeechServiceLike`）实现，不做类型 import。
  - 方案三：把 `lib/types/*.d.ts` 拷进项目自建 `.d.ts` 声明。
- 注：项目 `package.json` 的 peerDependencies 目前只声明了 cordis/dsh-agent/dsh-llm/dsh-session/schemastery；可考虑加一条 **可选** peer `@deepseek-ai/dsh-experimental-speech-to-text` 以便使用者感知依赖（非必须）。

---

## 5. 与本项目对接建议（`createDshTranscriber` 实现草案）

当前 `src/voice/stt.ts` 的 `createDshTranscriber()` 是抛错占位。可用真实 API 补全：

```ts
import type { AudioInput, DshSpeechServiceLike, Transcriber } from './stt.js';

/** 真实最小接口（可从真实 d.ts 抄）*/
interface RealSpeechService {
  snapshot(): { selection: { providerId: string; language: string } };
  listProviders(): ReadonlyArray<{ id: string; languages: readonly string[] }>;
  prepare(id: string, opts?: { downloadSource?: string }): void;
  follow(signal: AbortSignal): AsyncIterable<any>;
  resolve(req: { audio: Uint8Array; providerId?: string; language?: string }): any;
  transcribe(spec: any, signal: AbortSignal): Promise<{ text: string; audioSeconds: number; inferenceSeconds: number }>;
}

export function createDshTranscriber(service: DshSpeechServiceLike, providerId?: string): Transcriber {
  const svc = service as unknown as RealSpeechService;
  return {
    async transcribe(audio: AudioInput): Promise<string> {
      const id = providerId ?? svc.snapshot().selection.providerId;
      // 首次冷启动：确保 provider 可用（unprepared 时需 prepare，见 §3.6）
      const info = svc.listProviders().find((p) => p.id === id);
      if (!info) throw new Error(`DSH 未注册 provider: ${id}`);
      // 传 lang：AudioInput 无 language 时用 'auto'（切勿传 ''）
      const language = 'auto';
      const spec = svc.resolve({ audio: audio.data, providerId: id, language });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        const { text } = await svc.transcribe(spec, controller.signal);
        return (text ?? '').trim();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
```

在插件 `apply(ctx, config)` 里取服务并传入：

```ts
// 运行时惰性获取（未挂载 STT 时为 undefined，可降级）
const speech = (ctx.get('speechToText') ?? (ctx as any).speechToText);
// 调用统一入口时：
// await transcribe(config.stt, audio, { dsh: speech, dshProvider: 'sensevoice-local' });
```

> 注意：插件端应在 `config.stt.provider === 'dsh'` 且服务缺失时给出清晰报错（当前 `transcribe()` 已抛 `DSH speechToText 服务不可用`）。
> 建议将下载/冷启动与转写解耦：在插件启动或首次收语音时先做一次 `prepare()` + 观察就绪，避免第一条语音超时。

---

## 6. 只读验证命令（供复核，未启动/未杀进程）

```powershell
# 1) 确认安装级可解析（不安装任何东西）
node -e "const{createRequire}=require('module');const r=createRequire('C:/Users/user/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js');console.log(r.resolve('@deepseek-ai/dsh-experimental-speech-to-text-sensevoice'))"

# 2) 看 profile 是否已有这些包（预期：无）
Test-Path 'C:\Users\user\.dsh\profiles\qqbot-safe-dev\node_modules\@deepseek-ai\dsh-experimental-speech-to-text-sensevoice'

# 3) 看 sherpa 原生库（预期：在 dsh 安装内）
Get-ChildItem 'C:\Users\user\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\sherpa-onnx-win-x64'
```

挂载后用 DSH 自身只读命令核对（不启动新进程）：

```powershell
# 打印合并后的 profile 配置（若该 dsh 版本支持 --dump-config；以实际为准）
dsh --profile qqbot-safe-dev --dump-config
```

---

## 7. 证据文件清单（真实路径）

- `...\dsh-experimental-speech-to-text\lib\types\index.d.ts` — 服务类/方法签名
- `...\dsh-experimental-speech-to-text\lib\types\types.d.ts` — 全部类型
- `...\dsh-experimental-speech-to-text\lib\types\wave.d.ts` / `wave.js` — WAV 校验
- `...\dsh-experimental-speech-to-text\lib\index.js` — `resolve()`/`transcribe()`/Config（`defaultProvider` required、`language` 默认 `auto`）
- `...\dsh-experimental-speech-to-text-sensevoice\lib\types\config.d.ts` + `lib\index.js` — 全部 config 默认值、`inject`、`apply`
- `...\dsh-experimental-speech-to-text-sensevoice\runtime\assets.json` — 模型文件/大小/sha256/URL/revision
- `...\dsh-experimental-speech-to-text-sensevoice\lib\index.js` — 缓存布局、`inspect()/prepare()/execute()` 准入、平台白名单
- `...\dsh-experimental-voice-input-bundle\cordis.patch.yml` — 官方 bundle 的四条 entry 写法
- `...\dsh-experimental-api-speech-to-text\lib\types\index.d.ts` / `types.d.ts` — Remote 层（base64、`maxAudioBytes`/`maxDurationSeconds`）
- `...\dsh-app-boot\lib\index.js`（`collectInstallationScopePackages` / `createRuntimeResolution`）— two-anchor 解析
- `...\cordis-plugin-loader\lib\index.js`（`evaluate = new Function('ctx','expr','with(ctx){return eval(expr)}')`）— `!!js` 作用域
- `...\dsh-app-boot\lib\index.js`（`ctx.provide('dshHomePath', dshHomePath)`）— `dshHomePath` 可用
- 本项目：`src/voice/stt.ts`（占位 `createDshTranscriber`）、`src/config.ts`（`SttConfig`）、`cordis.patch.yml`、`package.json`
- profile：`~/.dsh/profiles/qqbot-safe-dev/{cordis.patch.yml,cordis.yml,package.json,pnpm-workspace.yaml}`
