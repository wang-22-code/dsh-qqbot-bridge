<div align="center">

# dsh-qqbot-bridge

**把 QQ 私聊 / 群聊安全地接入 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)**

给机器人发一条 QQ 消息，就等同于向一个独立的 DSH Agent 会话发送消息。

[![version](https://img.shields.io/badge/version-0.1.0-blue.svg)](#)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.1.0--rc.6-7c3aed.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![QQ](https://img.shields.io/badge/QQ-%E5%AE%98%E6%96%B9%E6%9C%BA%E5%99%A8%E4%BA%BA-12b7f5.svg)](#)

[特性](#-特性) · [快速开始](#-快速开始) · [配置](#-配置) · [使用](#-使用) · [扩展能力](#-扩展能力) · [常见问题](#-常见问题)

</div>

> **当前版本 `0.1.0`。** 项目仍处于早期阶段，建议先使用专用测试机器人、专用工作目录和私聊白名单。

---

## ✨ 特性

- **只用官方能力**：基于腾讯 QQ 机器人开放平台与腾讯官方 SDK，不使用个人 QQ 逆向协议、Hook、注入或模拟登录。
- **扫码即用**：首次启动支持腾讯官方扫码绑定，自动保存 `AppID`、`Secret` 和扫码用户 `OpenID`。
- **默认安全**：私聊默认白名单、群聊默认关闭；空白名单不会退化成开放访问。
- **双通道**：官方 QQ 机器人 + NapCatQQ 个人号（OneBot v11 正向 WS），私聊/群聊，支持文本与语音。
- **流式与可靠**：QQ 消息直接驱动 DSH Agent，支持流式回复、发送失败指数退避重试、会话持久化与模型切换。
- **记忆宫殿**：Markdown 事实 + JSON 索引，回复前召回、对话模型（LLM）语义抽取、压缩前（`compaction/start`）补存、按会话隔离。
- **情绪语音**：BreezeBlue 官方 API / OpenAI 兼容 / 本地 audiocpp，带情绪指令，官方与 OneBot 双通道发送语音条。
- **健壮性**：断线重连、心跳看门狗、发送重试、超时、消息去重、优雅关闭、NapCat 二维码轮询。
- **权限闭环**：可在 QQ 内处理 DSH 的一次性权限申请：`/approve CODE` / `/deny CODE`。
- **凭据不外泄**：`AppSecret`、`OpenID` 与 `API Key` 仅保存在本机 `.env`（项目根或 `$DSH_HOME`，均被 git 忽略），不进入仓库与日志。
- **工程保障**：内置隐私扫描、单元测试、类型检查、打包校验与 GitHub Actions CI。

---

## ⚖️ 合规说明

> [!IMPORTANT]
> 本项目仅面向腾讯官方机器人能力。使用前请遵守腾讯 QQ 开放平台规则、机器人运营规范与所在地法律法规。平台审核、接口权限、主动消息窗口与频率限制以腾讯当前规则为准。本项目不承诺账号绝对不会受限，也不会提供绕过风控或协议限制的实现。

---

## 📑 目录

- [特性](#-特性)
- [快速开始](#-快速开始)
- [配置](#-配置)
- [使用](#-使用)
- [扩展能力](#-扩展能力)
- [项目结构](#-项目结构)
- [开发与验证](#-开发与验证)
- [常见问题](#-常见问题)
- [参与贡献](#-参与贡献)
- [来源与许可](#-来源与许可)

---

## 🚀 快速开始

### 环境要求

| 组件 | 要求 |
| --- | --- |
| 操作系统 | Windows 10/11、macOS 或 Linux |
| Node.js | `>= 22`（唯一需要手动安装的运行时，其余由启动脚本处理） |
| DeepSeek API Key | **必填**（`DEEPSEEK_API_KEY`），不设置则无法生成任何回复 |
| QQ 机器人 | 一个腾讯官方 QQ 机器人（`AppSecret` 无需手填，首次扫码自动绑定） |
| pnpm / DSH CLI | **无需手动安装**，启动脚本自动处理（pnpm 走 corepack，DSH 装到 `$DSH_HOME/profiles`） |

> [!WARNING]
> **必须设置 `DEEPSEEK_API_KEY`。** DSH 默认使用 DeepSeek 官方接口（`provider: deepseek-official`），缺少 Key 时模型调用会在运行时失败，机器人只会回复「⚠️ 本轮处理出错，请重试。」。请把 Key 写入本机 DSH 环境文件，而不是项目目录：

```dotenv
# Windows 默认位置：C:\Users\<你>\.dsh\.env
# macOS/Linux 默认位置：~/.dsh/.env
DEEPSEEK_API_KEY="你的 API Key"
```

也可以命令行写入：

```powershell
$key = Read-Host -Prompt "粘贴你的 DeepSeek API Key"
Add-Content "$env:USERPROFILE\.dsh\.env" "DEEPSEEK_API_KEY=`"$key`""
```

### Windows：从源码一键启动（零配置）

唯一需要手动安装的是 [Node.js ≥ 22](https://nodejs.org)（和 git）。其余全部由脚本自动完成，无需手动装 pnpm、DSH CLI 或填写 AppSecret。

> [!NOTE]
> `dev-start.ps1`（Windows 版）**不包含 node 存在性检查**（与 Linux/macOS 版不同）。请确保 Node.js ≥ 22 已安装并加入 `PATH`。

```powershell
git clone https://github.com/JHf0912/dsh-qqbot-bridge.git
cd dsh-qqbot-bridge
powershell -ExecutionPolicy Bypass -File .\scripts\dev-start.ps1
```

脚本会自动完成：

1. **环境检查**：pnpm 缺失时自动启用 corepack（或创建垫片加入 `PATH`）；DSH CLI 缺失时自动安装到 `$DSH_HOME\profiles`（含 pnpm 11 必需的 `allowBuilds` 配置）。
2. **安装并构建**：安装依赖并编译 TypeScript。
3. **注册插件**：注册本地插件并链接到当前源码（后续 `pnpm build` 重建即可生效）。
4. **API Key**：缺失时终端提示输入并写入 `$DSH_HOME\.env`，已有则跳过。
5. **原生模块**：启动前探测并自动修复 node-pty 原生模块（缺失时重建、必要时源码编译，国内网络常见问题）。
6. **凭据预校验**：启动前调用腾讯接口校验 QQ 凭据；无效时当场提供 3 个选项（重新粘贴 / 删除并重新扫码 / 跳过继续），而不是等 DSH 启动后才失败。

首次没有 QQ 凭据时，终端会显示官方绑定二维码；扫码成功后插件自动写入（保存在 `$DSH_HOME/.env`，不写入仓库）：

```dotenv
QQBOT_APPID="..."
QQBOT_SECRET="..."
QQBOT_C2C_ALLOW="..."
```

> [!WARNING]
> **首次扫码后请停掉并重跑一次。** 首次扫码写入的 `QQBOT_C2C_ALLOW` 不会注入本次进程，重启后消息才会被接受。看到 `[im-qqbot] Bot ready! appId=...` 后即可在 QQ 中发送「你好」。

常用参数：`--profile 名称`（默认 `qqbot-safe-dev`）、`--skip-install`、`--build-only`、`--setup-only`（完成全部准备但不启动）。

以后启动可直接执行：

```powershell
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile qqbot-safe-dev
```

如设置了自定义 `DSH_HOME`，请替换为对应目录。

### Linux / macOS：从源码一键启动

```bash
git clone https://github.com/JHf0912/dsh-qqbot-bridge.git
cd dsh-qqbot-bridge
chmod +x scripts/dev-start.sh
./scripts/dev-start.sh
```

脚本完成的工作与 Windows 版一致，并额外做环境检查：

- node 未安装 → 报错并提示先安装 Node.js ≥ 22；
- pnpm 缺失 → 自动 `corepack enable`；
- DSH CLI 缺失 → 自动安装 `@deepseek-ai/dsh` 到 `$DSH_HOME/profiles`（含 `allowBuilds` 配置）；
- node-pty 原生模块缺失 → 自动重建、必要时源码编译；
- `DEEPSEEK_API_KEY` 缺失 → 交互式提示输入并写入 `$DSH_HOME/.env`。

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--profile 名称` | 指定 profile 名（默认 `qqbot-safe-dev`） |
| `--skip-install` | 跳过依赖安装 |
| `--build-only` | 只安装并构建，不启动 |
| `--setup-only` | 完成全部准备工作但不启动 DSH |

> [!NOTE]
> 首次启动同样需要扫码绑定；看到 `Bot ready` 后**重启一次**（首次写入的白名单不注入本次进程）。以后启动：
> ```bash
> node "$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile qqbot-safe-dev
> ```

### WSL 注意事项

> [!CAUTION]
> **必须安装 Linux 版 Node ≥ 22**（如 `nvm install 22`）。WSL 互操作会把 Windows 版 `node.exe` 暴露进 `PATH`，脚本检测到 `/mnt/...` 路径会直接拒绝并给出安装指引——否则会出现「终端无输出、Windows 桌面弹报错框」的静默崩溃。其余流程与 Linux/macOS 完全一致。

### Linux/macOS：从源码一键启动

脚本会自动检查环境：

- node 未安装 → 报错并提示先手动安装 Node.js >= 22（https://nodejs.org）；
- pnpm 缺失 → 自动执行 `corepack enable`；
- DSH CLI 缺失 → 自动安装 `@deepseek-ai/dsh` 到 `$DSH_HOME/profiles`（含 pnpm 11 必需的 `allowBuilds` 配置，避免原生依赖构建被拦截）；
- node-pty 原生模块缺失 → 自动重建、必要时源码编译（国内网络常见问题）；
- `DEEPSEEK_API_KEY` 缺失 → 交互式提示输入并写入 `$DSH_HOME/.env`，无需手动准备。

克隆仓库后，在项目根目录执行：

```bash
git clone https://github.com/JHf0912/dsh-qqbot-bridge.git
cd dsh-qqbot-bridge
chmod +x scripts/dev-start.sh
./scripts/dev-start.sh
```

脚本完成的工作与 Windows 版一致：安装依赖并构建 TypeScript、创建或更新 `qqbot-safe-dev` profile、将 profile 链接到当前源码、启动前校验 QQ 凭据、最后一步才启动 DSH。常用参数：

- `--profile 名称`：指定 profile 名（默认 `qqbot-safe-dev`）
- `--skip-install`：跳过依赖安装
- `--build-only`：只安装并构建，不启动
- `--setup-only`：完成全部准备工作但不启动 DSH（适合先跑一遍确认环境，再手动启动）

启动前脚本会调用腾讯接口预校验 `QQBOT_APPID`/`QQBOT_SECRET`，凭据无效（如 `invalid appid or secret`）时会直接报错并给出平台核对指引，而不是等 DSH 启动后才失败。

首次启动同样需要扫码绑定。看到 `Bot ready` 后重启一次（首次扫码写入的 `QQBOT_C2C_ALLOW` 不会注入本次进程，不重启白名单为空）。以后启动可直接执行：

```bash
node "$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile qqbot-safe-dev
```

### WSL 注意事项

- **必须安装 Linux 版 Node ≥ 22**（如 `nvm install 22`）。WSL 的互操作会把 Windows 版 `node.exe` 暴露进 PATH，脚本检测到 `/mnt/...` 路径会直接拒绝并给出安装指引——否则会出现「终端无输出、Windows 桌面弹报错框」的静默崩溃。
- 其余流程与 Linux/macOS 完全一致（自动装 pnpm/DSH、提示输入 API Key、启动前校验 QQ 凭据）。

### npm 发布后安装

```bash
dsh plugin --profile qqbot add dsh-qqbot-bridge
dsh --profile qqbot
```

如 `dsh` 未加入 `PATH`，直接调用 `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js`。

---

## ⚙️ 配置

### 私密文件（`.env`）

插件启动时会**自动加载项目根目录 `.env`**（也兼容 `$DSH_HOME/.env` 与 `DSH_QQBOT_ENV_FILE`）。**最简单的方式：把需要用的配置直接写进项目根目录 `.env`**——它已被 `.gitignore` 忽略，不会上传到仓库。

- 项目根：`<项目>/.env`（推荐，最简）
- 用户目录：`$DSH_HOME/.env`（DSH 核心仍从这里读取 `DEEPSEEK_API_KEY` 等）

> 优先级：已存在的环境变量 / `$DSH_HOME/.env` 不会被覆盖；其余缺失项由项目根 `.env` 补齐。

```dotenv
# QQ 官方机器人（channel=official）
QQBOT_APPID="机器人 AppID"
QQBOT_SECRET="机器人 AppSecret"
QQBOT_C2C_ALLOW="用户OpenID1,用户OpenID2"
# DSH 模型
DEEPSEEK_API_KEY="DeepSeek API Key"
# 通道：official | onebot
IM_QQBOT_CHANNEL="official"
# 情绪语音（BreezeBlue 示例）
VOICE_ENABLED="true"
VOICE_PROVIDER="breezeblue"
BREEZE_VOICE_ID="voc_xxxx"
BREEZE_API_KEY="BreezeBlue API Key"
```

完整键名见 [`.env.example`](.env.example)。多个 OpenID 用英文逗号分隔；**不要把个人 QQ 号当作 OpenID。**

### Profile 配置

首次执行 `dsh plugin add` 时，插件内置 bundle 的默认配置已自动生效（`provider: deepseek-official`、`model: deepseek-v4-flash`、私聊白名单、`cwd: ./qqbot-workspace` 等），**无需手动创建**。本节仅用于按需自定义。

配置位于 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。推荐把 OpenID 留在 `.env`，YAML 只读取环境变量：

```yaml
- id: im-qqbot
  config:
    cwd: 'D:/dsh-workspaces/qqbot'
    provider: deepseek-official
    model: deepseek-v4-flash
    requireMention: true

    access:
      c2cMode: allowlist
      c2cAllow: !!js >-
        (process.env.QQBOT_C2C_ALLOW ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      groupMode: disabled
      groupAllow: []

    acknowledgeOpenAccess: false
    allowUnsafeCwd: false
    logMessageContent: false
    enableApprovals: true
    approvalTimeoutMs: 120000
    debug: false
```

> [!NOTE]
> 修改 `.env` 或 profile 后需**完整重启** DSH：`Ctrl+C` 停止，再重新运行启动命令。

### 配置参考

| 配置 | 默认值 | 说明 |
| --- | ---: | --- |
| `channel` | `official` | 通道类型：`official`（腾讯官方）/ `onebot`（NapCat 个人号） |
| `provider` | `deepseek-official` | DSH LLM provider |
| `model` | `deepseek-v4-flash` | DSH 模型，可通过 `/model` 切换 |
| `cwd` | `./qqbot-workspace` | Agent 专用工作目录 |
| `requireMention` | `true` | 群聊是否必须 @机器人 |
| `access.c2cMode` | `allowlist` | 私聊访问策略 |
| `access.c2cAllow` | 来自环境变量 | 允许的用户 OpenID / QQ 号 |
| `access.groupMode` | `disabled` | 群聊访问策略 |
| `access.groupAllow` | `[]` | 允许的群 OpenID / 群号 |
| `acknowledgeOpenAccess` | `false` | 开放访问的二次风险确认 |
| `allowUnsafeCwd` | `false` | 是否允许根目录或用户主目录 |
| `logMessageContent` | `false` | 是否记录消息正文 |
| `enableApprovals` | `true` | 是否启用 QQ 一次性审批 |
| `approvalTimeoutMs` | `120000` | 审批超时，超时自动拒绝 |
| `streamFlushIntervalMs` | `2000` | 流式增量下发间隔(ms)，`0` = 关闭流式 |
| `sendMaxRetries` | `2` | 发送失败最大重试次数 |
| `sendRetryBaseMs` | `1000` | 发送重试指数退避基数(ms) |
| `debug` | `false` | SDK 诊断日志开关 |

> OneBot / 记忆 / 语音相关配置见下方「扩展能力」章节；这些项也可用环境变量覆盖（`IM_QQBOT_CHANNEL`、`ONEBOT_*`、`MEMORY_ENABLED`、`VOICE_*`、`BREEZE_*` 等，详见 [`.env.example`](.env.example)）。

> [!WARNING]
> 不建议使用开放模式。确需使用时，必须同时设置 `access.c2cMode: open` 与 `acknowledgeOpenAccess: true`——开放模式会让任何能找到机器人的用户触发 DSH Agent。

### 哪些内容不能上传

请勿提交或粘贴到 Issue、PR、截图与日志中：

- `$DSH_HOME/.env` 或项目 `.env`
- `QQBOT_SECRET`、`DEEPSEEK_API_KEY`
- 真实用户 / 群 OpenID、消息 ID、TraceId
- 二维码绑定链接或尚未失效的二维码
- `$DSH_HOME/sessions`、`qqbot-workspace`、聊天记录与生成文件

提交前运行：

```bash
pnpm privacy:check
pnpm check
```

`.gitignore` 已排除常见本地敏感文件，但不能替代人工复核。

---

## 🧭 使用

### 内置命令

| 命令 | 说明 |
| --- | --- |
| `/bot-help` | 查看帮助 |
| `/bot-status` | 查看会话、模型与用量状态 |
| `/bot-ping` | 连接测试 |
| `/bot-version` | 查看版本 |
| `/bot-reset` | 清除当前会话上下文 |
| `/bot-new` | 开始新会话 |
| `/bot-stop` | 终止当前任务（暂未实现） |
| `/model` | 查看或切换模型 |
| `/approve CODE` | 允许当前一次权限申请 |
| `/deny CODE` | 拒绝当前一次权限申请 |

### QQ 权限审批

当工具需要访问工作区之外的位置时，DSH 会先触发审批，插件向任务发起者发送：

```text
⚠️ DSH 权限申请
工具：pwsh
原因：需要访问工作区外路径

允许本次操作：/approve A1B2C3
拒绝本次操作：/deny A1B2C3
```

审批边界：

- 仅任务发起者本人可以处理；
- 验证码一次性使用；
- 只授权当前操作，不永久开放磁盘；
- 默认 120 秒超时自动拒绝；
- Agent 取消或 DSH 退出时自动取消；
- 群聊中其他成员即使看到验证码也不能批准。

---

## 🧩 扩展能力

> 参考社区项目 [wz20/dsh-dafeiyu-dot](https://github.com/wz20/dsh-dafeiyu-dot) 的分层解耦思路扩展而来。

### OneBot / NapCat 个人号通道

`channel: onebot` 时，插件连接 OneBot v11 正向 WebSocket（如 NapCatQQ），以**个人 QQ 号**收发消息，不再需要官方 AppID/Secret：

```yaml
channel: onebot
onebot:
  wsUrl: 'ws://127.0.0.1:3001'          # NapCat 正向 WebSocket
  accessToken: ''                       # OneBot access_token
  selfId: ''                            # 机器人 QQ 号（留空自动获取）
  reconnectMaxMs: 30000                 # 断线重连最大间隔
  webuiUrl: 'http://127.0.0.1:6099'     # 可选：NapCat WebUI，用于查询登录二维码
  webuiToken: ''                        # 可选：NapCat WebUI Token
```

- 私聊默认白名单、群聊默认关闭，沿用 `access` 配置（条目为 QQ 号 / 群号）。
- 收发文本复用同一套流式 / 切分 / 重试出站管线，并支持发送语音条。
- 健壮性：断线指数退避重连、**心跳看门狗**（`get_status` 连续失败自动重连）、**发送重试**（连接类错误退避重试）、消息去重、优雅关闭。
- 配置 `onebot.webuiUrl` 后，启动时会**轮询拉取登录二维码**（刷新到 PNG 并打印路径），可检测登录状态，方便插件内扫码。

> [!CAUTION]
> 个人号走第三方网关，存在账号风控 / 封号与合规风险，请自行评估，优先使用专用测试号。

### 记忆宫殿

- **存储**：`$DSH_HOME/dsh-qqbot-bridge/memory-palace/`（可用 `memory.dir` 覆盖），每个会话独立 `*.json` + `*.md`。
- **召回**：回复前按关键词召回最多 `memory.recallLimit` 条、总长 ≤ `memory.maxChars`，注入为「长期记忆」块。
- **命令**：`/memory`、`/memory add <文本>`、`/memory search <关键词>`、`/memory forget <id前缀>`；说「记住… / 记得…」会自动补存。
- **遗忘**：墓碑保留（可追溯），不物理删除；不同会话互不可见。
- **压缩前补存**：原始消息先无损写入来源队列（`*.sources.jsonl`）；在**真正的 DSH `compaction/start` 事件**以及每轮 `turn/end` 时，用**可插拔抽取器**提炼为长期事实。默认优先使用 **DSH 对话模型（LLM）做语义抽取**，失败自动降级到关键词规则（`keywordExtractor`），保证不因模型异常丢记忆；写盘为原子操作，避免损坏。

### 情绪语音 TTS

`voice.enabled: true` 且 `voice.provider` 设为 `breezeblue` / `openai` / `local` 时，助手完整回复后会合成语音并发送语音条；合成失败仅保留文字回复。**官方通道**用官方 SDK 的 `sendVoice`，**OneBot 通道**用 OneBot `record` 段，两者均已接入。

| 服务 | 关键配置 | 说明 |
| --- | --- | --- |
| BreezeBlue 官方 API | `breezeUrl / breezeModel / breezeVoice / apiKey` | 情绪走 `instructions` + `voice_settings.guidance_scale` |
| OpenAI 兼容 | `openaiUrl / openaiModel / openaiVoice` | `POST /audio/speech` |
| 本地 VoiceStudio (audiocpp) | `localUrl / localModel / localVoice` | 支持 `instructions` 情绪 |

语气判断为轻量关键词启发式，可设置 `voice.emotional: false` 关闭。

---

## 🗂 项目结构

```text
src/
├─ approval.ts          QQ 一次性审批通道
├─ channel/             OneBot 通道引导（复用 SessionManager + 出站管线）
├─ commands/            斜杠命令
├─ memory/              记忆宫殿（存储 / 检索 / 抽取 / LLM / 命令）
├─ model/               模型发现、路由与用户偏好
├─ session/             QQ peer 与 DSH Session 映射
├─ shared/              通用工具、.env 加载与发送辅助
├─ transport/           入站组装、出站缓冲与分片
│  └─ onebot/           OneBot v11 客户端、API、发送器、NapCat 登录
├─ voice/               情绪语音 TTS（BreezeBlue / OpenAI 兼容 / 本地）
├─ config.ts            配置 Schema
├─ security.ts          启动前安全校验
├─ setup.ts             官方扫码与私密凭据落盘
└─ index.ts             Cordis 插件入口与生命周期编排
```

详细设计见 [架构说明](docs/ARCHITECTURE.md)。

---

## 🛠 开发与验证

```bash
pnpm install --frozen-lockfile
pnpm build        # 编译 TypeScript
pnpm test         # 构建 + 单元测试
pnpm typecheck    # 类型检查
pnpm privacy:check
pnpm check        # 隐私扫描 + 构建 + 单测 + 类型检查 + 打包预览
```

> `pnpm check` 会一次性执行隐私扫描、构建、单元测试、类型检查和 npm 打包预览，是提交前推荐的自检命令。

---

## ❓ 常见问题

<details>
<summary><b>机器人显示「未连接服务」</b></summary>

确认启动终端仍在运行，并检查是否出现 `Bot ready`。
</details>

<details>
<summary><b>机器人完全不回复</b></summary>

检查 `QQBOT_C2C_ALLOW` 是否存在且是用户 OpenID（不是机器人 AppID）。
</details>

<details>
<summary><b>收到「⚠️ 本轮处理出错，请重试。」</b></summary>

DSH 本轮生成失败。先确认 `DEEPSEEK_API_KEY` 已配置且模型可用；若持续出现且日志含 `corrupt session log`，删除 `$DSH_HOME/sessions/` 下对应会话后重启。
</details>

<details>
<summary><b>DSH 直接 `turn/end`</b></summary>

显式配置 `provider` 和 `model`，并确认模型凭据可用。
</details>

<details>
<summary><b>权限申请没有出现</b></summary>

确认 `enableApprovals: true`、审批策略为 `ask`，且操作确实触发沙箱升级。
</details>

<details>
<summary><b>修改 `.env` 后无效</b></summary>

完整停止并重启 DSH。
</details>

<details>
<summary><b>启动前校验报 <code>invalid appid or secret</code>（code 100016）</b></summary>

`.env` 中的 QQ 凭据已过期或被重置。脚本会当场提供 3 个选项：`1` 重新粘贴 AppID/AppSecret、`2` 删除凭据并重新扫码绑定、`3` 跳过校验继续启动。也可到 [q.qq.com](https://q.qq.com) 的「开发设置」复制当前 AppSecret 后选 `1` 粘贴。

手动删除命令：

- Windows PowerShell：
  ```powershell
  (Get-Content "$env:USERPROFILE\.dsh\.env") | Where-Object { $_ -notmatch '^QQBOT_APPID=|^QQBOT_SECRET=' } | Set-Content "$env:USERPROFILE\.dsh\.env"
  ```
- Linux/macOS：
  ```bash
  sed -i '/^QQBOT_APPID=/d; /^QQBOT_SECRET=/d' ~/.dsh/.env
  ```
</details>

<details>
<summary><b>启动报 <code>Failed to load native module: pty.node</code></b></summary>

node-pty 原生模块未装上，国内网络从 GitHub 下载预编译包失败最常见。启动脚本会自动修复（补 `allowBuilds` → `pnpm rebuild node-pty` → `npx node-gyp` 源码编译）。

手动处理：先装编译工具（`sudo apt install -y build-essential python3`，CentOS 用 `yum install -y gcc-c++ make python3`），在 `~/.dsh/profiles` 的 `pnpm-workspace.yaml` 补上含 `node-pty: true` 的 `allowBuilds` 配置（内容见启动脚本），再执行：

```bash
cd node_modules/.pnpm/node-pty@*/node_modules/node-pty && npx --yes node-gyp@11 rebuild
```

若 `npx` 拉包缓慢，先 `npm config set registry https://registry.npmmirror.com`。
</details>

<details>
<summary><b>日志出现 peerDependencies WARN</b></summary>

`[WARN] The package dsh-qqbot-bridge ... peerDependencies ...` 是 `pnpm link` 链接开发模式下的正常提示（peer 依赖由 DSH 运行时提供），不影响运行，可忽略。
</details>

更多排查步骤见 [故障排查](docs/TROUBLESHOOTING.md)。

---

## 🤝 参与贡献

提交改动前请阅读 [CONTRIBUTING.md](docs/CONTRIBUTING.md) 与 [SECURITY.md](docs/SECURITY.md)。安全问题请通过 GitHub Security Advisory 私下报告，不要公开提交凭据或日志。

## 👤 作者与交流

- 作者：[wang-22-code](https://github.com/wang-22-code)
- QQ：`1722800850`

欢迎交流使用体验、问题反馈与改进建议。请勿通过公开 Issue、截图或聊天记录发送 AppSecret、API Key、OpenID 等敏感信息。

## 📄 来源与许可

本项目派生自腾讯官方 MIT 项目 [`@tencent-connect/dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot)，由社区独立维护，并非腾讯官方产品。详见 [LICENSE](LICENSE) 与 [NOTICE](docs/NOTICE)。
