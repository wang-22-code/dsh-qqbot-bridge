# Changelog

All notable changes are documented here. This project follows Semantic Versioning where practical.

## [Unreleased]

### Added

- NapCatQQ / OneBot v11 个人号通道（`channel: onebot`）：正向 WebSocket、私聊/群聊、文本流式复用、语音条发送。
- 记忆宫殿：Markdown 事实 + JSON 索引、回复前召回注入、`/memory` 命令、墓碑遗忘、按会话隔离、自动补存。
- 情绪语音 TTS：BreezeBlue 官方 API / OpenAI 兼容 / 本地 audiocpp，含情绪指令与 OneBot 语音发送。
- 官方 QQ 通道同样接入情绪语音（`bot.sendVoice`）与记忆宫殿。
- NapCat 登录二维码查询辅助（`onebot.webuiUrl` / `webuiToken`）：拉取二维码并保存 PNG。
- 记忆改为可插拔语义抽取器 + 轮次结束（压缩前）来源补存钩子（默认 keyword，可替换为对话模型）。
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
