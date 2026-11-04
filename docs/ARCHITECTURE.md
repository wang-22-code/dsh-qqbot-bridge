# 架构说明

## 设计目标

`dsh-qqbot-bridge` 是一个 Cordis 插件，把 QQ（官方机器人或 NapCat 个人号）消息转换为 DSH Agent 消息，并把 DSH Session 事件转换回 QQ 回复。设计优先级依次为：协议合规、默认拒绝、会话隔离、可诊断性、可扩展性、健壮性。

## 数据流

### 官方 QQ 机器人通道（channel = official）

```text
QQ Open Platform
  │ C2C / Group event
  ▼
Tencent official Node.js SDK
  │ middleware pipeline
  ├─ duplicate/self filter
  ├─ access allowlist
  ├─ /memory command interception + memory recall injection
  ├─ approval command interception
  ├─ mention/history/sanitizer
  ├─ rate/concurrency guard
  └─ envelope formatter
  ▼
Inbound transport  ── createUserMessage
  ▼
SessionManager ── ModelResolver
  │ followup
  ▼
DSH Agent / Session
  │ assistant/chunk, assistant/message, turn/end, compaction/start
  ├─ outbound buffer & chunker → official sendMarkdown
  ├─ memory recall / source 补存 / LLM 抽取
  └─ voice TTS → official sendVoice
  ▼
QQ user or group
```

### OneBot / NapCat 个人号通道（channel = onebot）

```text
QQ ⇄ NapCatQQ ⇄ OneBot v11 正向 WebSocket ⇄ OneBotClient
  │ 归一化消息（段解析 / @ / 白名单 / 去重）
  ▼
SessionManager（复用官方通道的会话/模型/preset）
  │ followup
  ▼
DSH Agent / Session
  ├─ createOutboundHandler → OneBotSender（文本 / record 语音）
  └─ memory recall / 补存 / LLM 抽取、voice TTS → OneBot record
```

## 模块职责

### 插件入口

`src/index.ts` 负责：加载项目根 `.env`、依赖注入、按 `channel` 分流、SDK 中间件排序、事件注册、生命周期释放、以及"选择记忆抽取器"（LLM 优先、关键词兜底）。业务逻辑放在独立模块。

### 配置与安全

- `src/config.ts`：Cordis 配置 Schema 和默认值（含 `channel` / `onebot` / `memory` / `voice`）。
- `src/security.ts`：打开网络连接前验证工作目录、开放访问确认、白名单状态。
- `src/setup.ts`：腾讯官方扫码连接器，原子替换写入 `$DSH_HOME/.env`。
- `src/shared/env-loader.ts`：启动时加载**项目根 `.env`**（及包目录 `.env`），只补缺失变量、不覆盖 `$DSH_HOME/.env` 已注入的值；让"项目内 `.env`"成为最简配置入口。

### 会话与模型

- `src/session/`：把 `appId + scope + peerId` 映射为确定性 SessionId；同一 peer 恢复同一会话；模型切换通过 fork 保留历史；闲置回收。
- `src/model/`：默认路由、用户覆盖、模型枚举、偏好持久化。

### 消息传输（官方通道）

- `src/transport/inbound.ts`：正文/引用/群历史/附件描述组装成 DSH UserMessage。
- `src/transport/outbound.ts`：订阅 DSH Session 事件。
- `src/transport/outbound-buffer.ts`：合并流式文本、前缀记账、失败指数退避重试、代码块围栏吸附。
- `src/transport/chunker.ts`：按 QQ 长度限制切分 Markdown。

### OneBot 通道

- `src/transport/onebot/client.ts`：OneBot v11 正向 WS 客户端，`access_token`、`action/echo` 关联、指数退避重连、`forceReconnect`。
- `src/transport/onebot/api.ts`：`send_private_msg / send_group_msg / send_record / get_login_info`，发送类 action 带"连接类错误"重试（业务错误不重试）。
- `src/transport/onebot/sender.ts`：实现出站 `QQBotSender`，复用同一套流式/切分/重试管线。
- `src/transport/onebot/inbound.ts`：纯函数归一化（段解析、文本、@、白名单、回复目标）。
- `src/transport/onebot/napcat-login.ts`：NapCat 登录二维码获取与**轮询**（刷新二维码、检测登录状态、超时/中止）。
- `src/channel/onebot.ts`：通道引导（接入 SessionManager + 出站 + 心跳看门狗 + 消息去重 + 优雅关闭）。

### 记忆宫殿

- `src/memory/store.ts`：Markdown 事实 + JSON 索引，按会话隔离，墓碑遗忘，来源队列（`*.sources.jsonl`），**原子写盘**。
- `src/memory/commands.ts`：`/memory list|add|search|forget`，及「记住…」自动补存。
- `src/memory/extract.ts`：`MemoryExtractor` 接口、`keywordExtractor`、`createResilientExtractor`（主抽取器失败自动降级）。
- `src/memory/llm-extractor.ts`：用 DSH `ctx.llm.stream({provider,model,messages,signal})` 做**对话模型语义抽取**。
- 触发：每轮 `turn/end` 与**真正的 DSH `compaction/start`（压缩前）**对来源队列执行抽取，写入长期事实。

### 情绪语音 TTS

- `src/voice/tts.ts`：BreezeBlue 官方 API / OpenAI 兼容 / 本地 audiocpp，三路请求构造；情绪指令作为 `instructions`；**失败重试 + 单次超时 + 空音频校验**；返回本地临时 WAV。
- 发送：官方通道 `bot.sendVoice`，OneBot 通道 `record` 段；失败重试一次，仍失败只保留文字。

### 权限审批

`src/approval.ts` 是 DSH `approval/request` waterfall 的 QQ answerer：只接管本插件 Agent、生成一次性验证码、只接受相同 peer/sender 的明确命令、超时/取消/卸载失败关闭。不改变全局沙箱，不提供永久授权。

## 信任边界

- QQ OpenID / QQ 号是访问标识，不是身份认证替代；只信任事件提供的 senderId。
- `.env`（项目根或 `$DSH_HOME`）与 Session 数据属本机私密层，不进源码、不进日志。
- QQ 回复只能代表用户对单次审批的决定，不能提升插件自身权限。
- DSH 沙箱与审批服务是最终执行边界；插件不绕过。

## 扩展原则

- 新平台适配器复用 Session/Transport 抽象，不把平台字段泄漏到 Agent 层。
- 新命令放入 `src/commands/`，通过工厂注入依赖。
- 新的安全敏感配置默认拒绝，并提供显式风险确认。
- 日志默认不得包含正文、Secret、完整 OpenID 或附件签名 URL。
