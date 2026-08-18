import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { parse, resolve } from 'node:path';
import type { ImQQBotConfig } from './config.js';

export interface SecurityCheck {
  errors: string[];
  warnings: string[];
  cwd: string;
}

/** Validate security-sensitive settings before any network connection is opened. */
export function validateSecurityConfig(config: ImQQBotConfig): SecurityCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cwd = resolve(config.cwd || process.cwd());
  const root = parse(cwd).root;

  if (cwd === root && !config.allowUnsafeCwd) {
    errors.push('Agent 工作目录不能是文件系统根目录；请配置专用目录，或显式设置 allowUnsafeCwd: true');
  }

  if (cwd === resolve(homedir()) && !config.allowUnsafeCwd) {
    errors.push('Agent 工作目录不能直接使用用户主目录；请配置专用目录，或显式设置 allowUnsafeCwd: true');
  }

  const openScopes = [
    config.access.c2cMode === 'open' ? '私聊' : '',
    config.access.groupMode === 'open' ? '群聊' : '',
  ].filter(Boolean);
  if (openScopes.length > 0 && !config.acknowledgeOpenAccess) {
    errors.push(`${openScopes.join('、')}配置为 open；如确实需要，请显式设置 acknowledgeOpenAccess: true`);
  }

  if (config.access.c2cMode === 'allowlist' && config.access.c2cAllow.length === 0) {
    warnings.push('私聊白名单为空：所有私聊消息都会被拒绝');
  }
  if (config.access.groupMode === 'allowlist' && config.access.groupAllow.length === 0) {
    warnings.push('群聊白名单为空：所有群聊消息都会被拒绝');
  }
  if (config.access.groupMode !== 'disabled' && !config.requireMention) {
    warnings.push('群聊已启用但未要求 @机器人，容易被普通聊天意外触发');
  }
  if (config.debug || config.logMessageContent) {
    warnings.push('消息调试/正文日志已启用，日志可能包含聊天内容、OpenID 或附件地址');
  }

  if (usesDeepSeekProvider(config) && !process.env.DEEPSEEK_API_KEY) {
    warnings.push('未检测到 DEEPSEEK_API_KEY：模型调用会在运行时失败；请在 $DSH_HOME/.env 或启动环境中配置');
  }

  return { errors, warnings, cwd };
}

/** 判断是否路由到 DeepSeek 官方接口（该路由必须提供 DEEPSEEK_API_KEY） */
function usesDeepSeekProvider(config: ImQQBotConfig): boolean {
  return config.provider === 'deepseek-official';
}

/** Stable pseudonym for logs; does not expose the QQ OpenID itself. */
export function peerFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
