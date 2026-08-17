# dsh-qqbot-bridge

基于腾讯官方 QQ 机器人开放平台，将 QQ 私聊或群聊安全地接入 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)。给机器人发送消息，就等同于向一个独立的 DSH Agent 会话发送消息。

> 当前版本：`0.1.0`。项目仍处于早期阶段，建议先使用专用测试机器人、专用工作目录和私聊白名单。

## 特性

- 只使用腾讯 QQ 机器人开放平台和腾讯官方 SDK，不使用个人 QQ 逆向协议、Hook、注入或模拟登录。
- 首次启动支持腾讯官方扫码绑定，自动保存 AppID、Secret 和扫码用户 OpenID。
- 私聊默认白名单，群聊默认关闭；空白名单不会退化成开放访问。
- QQ 消息直接驱动 DSH Agent，支持流式回复、发送失败自动重试、会话持久化和模型切换。
- 支持在 QQ 内处理 DSH 的一次性权限申请：`/approve CODE` 或 `/deny CODE`。
- AppSecret、OpenID 和 API Key 仅保存在本机 `$DSH_HOME/.env`，不进入项目配置和日志。
- 内置隐私扫描、单元测试、打包检查和 GitHub Actions CI。

## 合规说明

本项目仅面向腾讯官方机器人能力。使用前请遵守腾讯 QQ 开放平台规则、机器人运营规范和所在地法律法规。平台审核、接口权限、主动消息窗口和频率限制以腾讯当前规则为准。本项目无法承诺账号绝对不会受到限制，但不会提供绕过风控或协议限制的实现。

## 快速启动

### 准备条件

- Windows 10/11、macOS 或 Linux
- Node.js `>= 22`（唯一需要手动安装的运行时，其余由启动脚本自动处理）
- **必须**：DeepSeek API Key（`DEEPSEEK_API_KEY`）——不设置时机器人无法生成任何回复
- 一个腾讯官方 QQ 机器人（AppSecret 无需手动填写，首次启动扫码自动绑定）
- pnpm 与 DSH CLI **无需手动安装**——启动脚本会自动装好（pnpm 走 corepack，DSH 装到 `$DSH_HOME\profiles`）

> ⚠️ **必填项**：必须设置 `DEEPSEEK_API_KEY`。DSH 默认使用 DeepSeek 官方接口（`provider: deepseek-official`），缺少 API Key 时模型调用会在运行时直接失败，机器人只会回复「⚠️ 本轮处理出错，请重试。」，启动日志中也会出现警告。请把 API Key 写入本机 DSH 环境文件，而不是项目目录：

```dotenv
# Windows 默认位置：C:\Users\<你>\.dsh\.env
# macOS/Linux 默认位置：~/.dsh/.env
DEEPSEEK_API_KEY="你的 API Key"
```

或者命令行设置：
```
$key = Read-Host -Prompt "粘贴你的 DeepSeek API Key"
Add-Content "$env:USERPROFILE\.dsh\.env" "DEEPSEEK_API_KEY=`"$key`""
```

### Windows：从源码一键启动（零配置）

唯一需要手动安装的是 [Node.js ≥ 22](https://nodejs.org)（和 git）。其余全部由脚本自动完成——不要求你手动装 pnpm、DSH CLI 或写 AppSecret。

> 设计说明：`dev-start.ps1`（Windows 版）**不包含 node 存在性检查**（与 Linux/macOS 版不同）。请确保 Node.js ≥ 22 已安装并加入 PATH；若缺失，脚本会在后续调用原生命令时报错。

```powershell
git clone https://github.com/JHf0912/dsh-qqbot-bridge.git
cd dsh-qqbot-bridge
powershell -ExecutionPolicy Bypass -File .\scripts\dev-start.ps1
```

脚本自动完成：

1. 环境检查：pnpm 缺失时自动启用 corepack（或创建垫片加入 PATH）；DSH CLI 缺失时自动安装到 `$DSH_HOME\profiles`（含 pnpm 11 必需的 `allowBuilds` 配置）；
2. 安装依赖并构建 TypeScript；
3. 注册本地插件并链接到当前源码（后续 `pnpm build` 重建即可生效）；
4. `DEEPSEEK_API_KEY` 缺失 → 终端提示输入并写入 `$DSH_HOME\.env`，已有则跳过；
5. 启动前探测并自动修复 node-pty 原生模块（缺失时自动重建、必要时源码编译，国内网络下常见问题）；
6. 启动前调用腾讯接口预校验 QQ 凭据——无效时当场提供 3 个选项：重新粘贴凭据 / 删除并重新扫码 / 跳过继续，而不是等 DSH 启动后才失败。

首次没有 QQ 凭据时，终端会显示官方绑定二维码。扫码成功后，插件会自动写入：

```dotenv
QQBOT_APPID="..."
QQBOT_SECRET="..."
QQBOT_C2C_ALLOW="..."
```

这些值保存在 `$DSH_HOME/.env`，不会写入仓库。扫码用户会自动成为第一个私聊白名单用户。

> ⚠️ **首次扫码后请停掉并重跑一次**：首次扫码写入的 `QQBOT_C2C_ALLOW` 白名单不会注入本次进程，重启后消息才会被接受。看到 `[im-qqbot] Bot ready! appId=...` 后即可在 QQ 中发送“你好”。

常用参数：`--profile 名称`（默认 `qqbot-safe-dev`）、`--skip-install`、`--build-only`、`--setup-only`（完成全部准备但不启动）。

以后启动可直接执行：

```powershell
node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile qqbot-safe-dev
```

如果设置了自定义 `DSH_HOME`，请将路径替换为对应目录。

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

如果 `dsh` 没有加入 PATH，可直接调用 `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js`。

## 隐私配置教程

### 本机私密文件

所有敏感配置统一放在：

```text
$DSH_HOME/.env
```

默认位置：

- Windows：`C:\Users\<你>\.dsh\.env`
- macOS/Linux：`~/.dsh/.env`

示例：

```dotenv
QQBOT_APPID="机器人 AppID"
QQBOT_SECRET="机器人 AppSecret"
QQBOT_C2C_ALLOW="用户OpenID1,用户OpenID2"
DEEPSEEK_API_KEY="DeepSeek API Key"
```

多个用户 OpenID 使用英文逗号分隔。不要把个人 QQ 号当作 OpenID。

### Profile 配置

首次执行 `dsh plugin add` 时插件自带的 bundle 默认配置已自动生效（`provider: deepseek-official`、`model: deepseek-v4-flash`、私聊白名单、`cwd: ./qqbot-workspace` 等），**无需手动创建**。本节只用于按需自定义。

Profile 配置位于 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。推荐保持 OpenID 在 `.env`，YAML 只读取环境变量：

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

修改 `.env` 或 profile 后应完整重启 DSH：`Ctrl+C` 停止，再重新运行启动命令。

### 哪些内容不能上传

不要提交或粘贴到 Issue、PR、截图和日志中：

- `$DSH_HOME/.env` 或项目 `.env`
- `QQBOT_SECRET`、`DEEPSEEK_API_KEY`
- 真实用户/群 OpenID、消息 ID、TraceId
- 二维码绑定链接或尚未失效的二维码
- `$DSH_HOME/sessions`、`qqbot-workspace`、聊天记录和生成文件

提交前运行：

```bash
pnpm privacy:check
pnpm check
```

`.gitignore` 已排除常见本地敏感文件，但不能替代人工复核。

## QQ 权限审批

当工具需要访问工作区之外的位置时，DSH 会先触发审批。插件向任务发起者发送：

```text
⚠️ DSH 权限申请
工具：pwsh
原因：需要访问工作区外路径

允许本次操作：/approve A1B2C3
拒绝本次操作：/deny A1B2C3
```

审批具有以下边界：

- 仅任务发起者本人可以处理；
- 验证码一次性使用；
- 只授权当前操作，不永久开放磁盘；
- 默认 120 秒超时自动拒绝；
- Agent 取消或 DSH 退出时自动取消；
- 群聊中其他成员即使看到验证码也不能批准。

## 主要配置

| 配置                      |                默认值 | 说明                                               |
| ------------------------- | --------------------: | -------------------------------------------------- |
| `provider`              | `deepseek-official` | DSH LLM provider                                   |
| `model`                 | `deepseek-v4-flash` | DSH 模型；可通过`/model` 切换                    |
| `cwd`                   | `./qqbot-workspace` | Agent 专用工作目录                                 |
| `requireMention`        |              `true` | 群聊是否必须 @机器人                               |
| `access.c2cMode`        |         `allowlist` | 私聊访问策略                                       |
| `access.c2cAllow`       |          来自环境变量 | 允许的用户 OpenID                                  |
| `access.groupMode`      |          `disabled` | 群聊访问策略                                       |
| `access.groupAllow`     |                `[]` | 允许的群 OpenID                                    |
| `acknowledgeOpenAccess` |             `false` | 开放访问的二次风险确认                             |
| `allowUnsafeCwd`        |             `false` | 是否允许根目录或用户主目录                         |
| `logMessageContent`     |             `false` | 是否记录消息正文                                   |
| `enableApprovals`       |              `true` | 是否启用 QQ 一次性审批                             |
| `approvalTimeoutMs`     |            `120000` | 审批超时，超时自动拒绝                             |
| `streamFlushIntervalMs` |              `2000` | 流式增量下发间隔(ms)，`0`=关闭流式（等整条消息） |
| `sendMaxRetries`        |                 `2` | QQ 回复发送失败最大重试次数                        |
| `sendRetryBaseMs`       |              `1000` | 发送重试指数退避基数(ms)                           |
| `debug`                 |             `false` | SDK 诊断日志开关                                   |

不建议使用开放模式。如果确实需要：

```yaml
access:
  c2cMode: open
acknowledgeOpenAccess: true
```

开放模式会让任何能找到机器人的用户触发 DSH Agent。

## 内置命令

- `/bot-help`：查看帮助
- `/bot-status`：查看会话、模型和用量状态
- `/bot-ping`：连接测试
- `/bot-version`：查看版本
- `/bot-reset`：清除当前会话上下文
- `/bot-new`：开始新会话
- `/bot-stop`：终止当前任务（暂未实现）
- `/model`：查看或切换模型
- `/approve CODE`：允许当前一次权限申请
- `/deny CODE`：拒绝当前一次权限申请

## 项目结构

```text
src/
├─ approval.ts          QQ 一次性审批通道
├─ commands/            斜杠命令
├─ model/               模型发现、路由和用户偏好
├─ session/             QQ peer 与 DSH Session 映射
├─ shared/              通用工具和发送辅助
├─ transport/           入站组装、出站缓冲和分片
├─ config.ts            配置 Schema
├─ security.ts          启动前安全校验
├─ setup.ts             官方扫码与私密凭据落盘
└─ index.ts             Cordis 插件入口和生命周期编排
```

详细设计见 [架构说明](docs/ARCHITECTURE.md)。

## 开发与验证

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
pnpm privacy:check
pnpm check
```

`pnpm check` 会执行隐私扫描、构建、单元测试、类型检查和 npm 打包预览。

## 常见问题

- 机器人显示“未连接服务”：确认启动终端仍在运行，并检查是否出现 `Bot ready`。
- 机器人完全不回复：检查 `QQBOT_C2C_ALLOW` 是否存在且是用户 OpenID，不是机器人 AppID。
- 收到「⚠️ 本轮处理出错，请重试。」：DSH 本轮生成失败。先确认 `DEEPSEEK_API_KEY` 已配置且模型可用；若持续出现且日志含 `corrupt session log`，删除 `$DSH_HOME/sessions/` 下对应会话后重启。
- DSH 直接 `turn/end`：显式配置 `provider` 和 `model`，并确认模型凭据可用。
- 权限申请没有出现：确认 `enableApprovals: true`、审批策略为 `ask`，且操作确实触发沙箱升级。
- 修改 `.env` 后无效：完整停止并重启 DSH。
- 启动前校验报 `invalid appid or secret`（code 100016）：`.env` 中的 QQ 凭据已过期或被重置。此时脚本会当场提供 3 个选项：`1` 重新粘贴 AppID/AppSecret（写入后立即重新校验）、`2` 删除凭据并重新扫码绑定、`3` 跳过校验继续启动。也可到 q.qq.com 的「开发设置」复制当前 AppSecret 后选 `1` 粘贴。手动删除命令：Windows PowerShell `(Get-Content "$env:USERPROFILE\.dsh\.env") | Where-Object { $_ -notmatch '^QQBOT_APPID=|^QQBOT_SECRET=' } | Set-Content "$env:USERPROFILE\.dsh\.env"`；Linux/macOS `sed -i '/^QQBOT_APPID=/d; /^QQBOT_SECRET=/d' ~/.dsh/.env`。
- 启动报 `Failed to load native module: pty.node`（或 `dsh: plugin tree failed to load`）：node-pty 原生模块未装上，国内网络从 GitHub 下载预编译包失败最常见。启动脚本会自动修复（补 allowBuilds 配置 → `pnpm rebuild node-pty` → `npx node-gyp` 源码编译）。手动处理：先装编译工具（`sudo apt install -y build-essential python3`，CentOS 用 `yum install -y gcc-c++ make python3`），然后在 `~/.dsh/profiles` 补上含 `node-pty: true` 的 `pnpm-workspace.yaml` allowBuilds 配置（内容见启动脚本），再执行 `cd node_modules/.pnpm/node-pty@*/node_modules/node-pty && npx --yes node-gyp@11 rebuild`。若 `npx` 拉包缓慢，先 `npm config set registry https://registry.npmmirror.com`。
- 启动日志出现 `[WARN] The package dsh-qqbot-bridge ... peerDependencies ...`：`pnpm link` 链接开发模式下的正常提示（peer 依赖由 DSH 运行时提供），不影响运行，可忽略。

更多排查步骤见 [故障排查](docs/TROUBLESHOOTING.md)。

## 参与贡献

提交改动前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。安全问题请通过 GitHub Security Advisory 私下报告，不要公开提交凭据或日志。

## 作者与交流

- 作者：[wang-22-code](https://github.com/wang-22-code)
- QQ：`1722800850`

欢迎交流使用体验、问题反馈和改进建议。请勿通过公开 Issue、截图或聊天记录发送 AppSecret、API Key、OpenID 等敏感信息。

## 来源与许可

本项目派生自腾讯官方 MIT 项目 [`@tencent-connect/dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot)，由社区独立维护，并非腾讯官方产品。详见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
