# 故障排查

## 启动检查顺序

1. 确认 Node.js `>= 22`。
2. 确认 DSH 进程保持运行。
3. 确认终端出现 `Bot ready!`。
4. 确认 `$DSH_HOME/.env` 中四个键存在且非空：`QQBOT_APPID`、`QQBOT_SECRET`、`QQBOT_C2C_ALLOW`、模型 API Key。
5. 确认 profile 的 `provider/model` 可用。

不要把这些值粘贴到 Issue。可以只报告键是否存在、值长度和错误码。

## 私聊没有回复

- `c2cAllow` 必须包含用户 OpenID，不是个人 QQ 号，也不是机器人 AppID。
- `${c2cAllow}` 是普通字符串，不会自动插值。使用 README 中的 `!!js process.env...`。
- 修改 `.env` 后完整重启 DSH。
- 临时设置 `debug: true`，发送一条新消息并观察 `C2C_MESSAGE_CREATE`。排查完恢复 `false`。

## 显示“机器人未连接服务”

说明腾讯没有检测到在线 WebSocket：

- 检查终端是否出现 `invalid appid or secret`；如有，重新进行官方扫码绑定或在开放平台重置 Secret。
- 检查代理、防火墙是否允许访问 `bots.qq.com`、`api.sgroup.qq.com` 和 WebSocket。
- 不要同时运行多个使用相同 AppID 的测试实例。

## 收到消息但立即结束

如果 Session 中出现 `has no provider/model`，在 profile 显式配置：

```yaml
provider: deepseek-official
model: deepseek-v4-flash
```

如果模型接口报鉴权错误，检查模型 API Key，但不要公开输出它。

## 权限审批不可用

- profile 需要 `enableApprovals: true`。
- DSH approval policy 必须为 `ask`，`never` 会直接拒绝。
- 审批命令必须带当前验证码，例如 `/approve A1B2C3`。
- 只有任务发起者可以批准；验证码过期后必须重新触发操作。

## 安全地提供日志

可以提供：

- 事件类型、HTTP 状态码和错误码；
- Node/DSH/插件版本；
- 已打码的 AppID；
- 是否出现 `READY`、`C2C_MESSAGE_CREATE`、`assistant/message`。

必须删除：Secret、API Key、OpenID、msg_id、二维码 URL、聊天正文、文件签名 URL。

## OneBot / NapCat 个人号通道

- **未连接**：确认 NapCatQQ 已启动并开启 OneBot v11 **正向 WebSocket**，`onebot.wsUrl` / `accessToken` 正确；日志应出现 `[onebot] WebSocket 已连接`。
- **登录**：配置 `onebot.webuiUrl`（+ `webuiToken`）后，插件会**轮询拉取登录二维码**（保存 PNG 并打印路径）并检测登录；也可直接用 NapCat 自带扫码。
- **消息不回复**：`access.c2cAllow` / `groupAllow` 要填 **QQ 号 / 群号**（不是 OpenID）；群聊需 `groupMode: allowlist` 且被 `@`；`groupMode: disabled` 则群消息一律忽略。
- **频繁重连**：心跳看门狗在 `get_status` 连续连接类失败时会强制重连；业务错误（`retcode≠0`）不会重试，按 retcode 提示排查。
- **语音发不出**：确认 OneBot 网关支持 `record` 段；语音合成失败会保留文字回复。

## 情绪语音 TTS

- **BreezeBlue 错误码**：`401` Key 无效；`402` 额度不足；`403/404` 模型/音色/地址不可用；`429` 限流；超时/异常会按退避重试。
- **没有语音只有文字**：检查 `voice.enabled`、`voice.provider`、`breezeVoice`（voice_id）、`BREEZE_API_KEY`；合成/发送失败只保留文字，是预期降级。
- **官方通道发不出语音**：`bot.sendVoice` 需要对应平台富媒体权限。
- 语音合成为短文本（`voice.maxChars`，默认 1000 字），过长会截断。

## 记忆宫殿

- **位置**：`$DSH_HOME/dsh-qqbot-bridge/memory-palace/`（`memory.dir` 可覆盖），每会话独立 `*.json` + `*.md`。
- **抽取器**：启动日志打印 `使用 LLM 语义抽取器` 或 `使用关键词抽取器`；LLM 失败会自动降级关键词。
- **补存时机**：每轮 `turn/end` 与 DSH `compaction/start`（压缩前）对来源队列执行抽取。
- **命令没反应**：`/memory` 需在私聊白名单内；群聊需被 @ 且启用。
- **记得不准**：语义抽取质量取决于模型；可换更强模型，或手动 `/memory add` 校正、`/memory forget` 遗忘。

## 环境变量加载

- 插件启动会加载**项目根 `.env`**（也兼容 `DSH_QQBOT_ENV_FILE` 与 `$DSH_HOME/.env`）；只补缺失、不覆盖已有值，因此 `$DSH_HOME/.env` 优先。
- 改完 `.env` 需**完整重启** DSH。
- 支持用环境变量覆盖：`IM_QQBOT_CHANNEL`、`ONEBOT_*`、`MEMORY_ENABLED`、`VOICE_ENABLED`、`VOICE_PROVIDER`、`BREEZE_*` 等（见 `.env.example`）。
