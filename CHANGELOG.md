# Changelog

All notable changes are documented here. This project follows Semantic Versioning where practical.

## [Unreleased]

### Added

- NapCatQQ / OneBot v11 个人号通道（`channel: onebot`）：正向 WebSocket、私聊/群聊、文本流式复用、语音条发送。
- OneBot 健壮性：断线指数退避重连、心跳看门狗（`get_status` 连续失败自动重连）、发送类错误重试、消息去重、优雅关闭、NapCat 登录二维码轮询。
- 记忆宫殿：Markdown 事实 + JSON 索引、回复前召回注入、`/memory` 命令、墓碑遗忘、按会话隔离、自动补存。
- 记忆抽取：默认用 DSH 对话模型（LLM）做语义抽取，失败自动降级关键词；"压缩前补存"挂到真正的 DSH `compaction/start` 事件；JSON/Markdown 原子写盘。
- 情绪语音 TTS：BreezeBlue 官方 API / OpenAI 兼容 / 本地 audiocpp，含情绪指令；官方通道 `sendVoice` 与 OneBot `record` 双通道发送。
- 语音健壮性：合成失败重试 + 超时 + 空音频校验；语音发送失败重试一次，仍失败保留文字回复。
- 项目根目录 `.env` 自动加载（只补缺失、不覆盖 `$DSH_HOME/.env`），让项目内 `.env` 成为最简配置入口；支持用环境变量覆盖 channel / onebot / memory / voice。
- 基于真实 WebSocket 服务器的 OneBot 端到端冒烟测试（握手 / 事件 / action-echo / 发送器）。

### Fixed

- Outbound streaming now actually streams: incremental sends are scheduled
  during generation (`streamFlushIntervalMs`), instead of waiting for the
  whole message. Set it to `0` to keep the previous batched behavior.
- Failed QQ sends no longer silently drop the turn's output. Unsent content
  is retained and retried with exponential backoff (`sendMaxRetries`,
  `sendRetryBaseMs`); once retries are exhausted the user is notified.
- `turn/end` errors are now surfaced to the user instead of being debug-only
  logs.

### Added

- QQ-backed one-shot DSH approval requests.
- Official QR onboarding that persists AppID, Secret, and the scanner's OpenID locally.
- Privacy check, GitHub Actions CI, community templates, architecture and troubleshooting docs.
- Windows source quick-start script.

### Security

- Private chat defaults to a fail-closed allowlist.
- Credentials and OpenIDs are kept outside the repository in `$DSH_HOME/.env`.
- Debug gateway bodies and QQ identifiers are redacted.

## [0.1.0] - 2026-08-16

- Initial community release derived from Tencent's MIT-licensed DSH QQ Bot plugin.
