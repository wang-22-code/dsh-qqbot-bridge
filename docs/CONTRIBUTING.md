# 贡献指南

感谢参与 `dsh-qqbot-bridge`。

## 开发环境

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

项目只提交 `pnpm-lock.yaml`，不要生成或提交 `package-lock.json`、`yarn.lock`。

## 修改原则

- 只使用腾讯官方 QQ Bot API/SDK。
- 安全敏感功能必须默认拒绝或最小授权。
- 不新增个人 QQ 逆向协议、Hook、注入、模拟登录或风控绕过。
- 不在测试、文档、fixture 或截图中提交真实凭据、OpenID 和聊天记录。
- 行为变化应补测试和 CHANGELOG 条目。
- 保持 `src/index.ts` 为编排层，业务逻辑放入对应模块。

## Pull Request 检查表

提交 PR 前确认：

```bash
pnpm privacy:check
pnpm check
```

PR 描述应包括动机、行为变化、测试结果、安全影响和兼容性影响。不要在公开 PR 中报告未修复漏洞，安全问题请参阅 [SECURITY.md](SECURITY.md)。
