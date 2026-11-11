/**
 * 轻量 .env 加载器
 *
 * 目的：让"项目根目录 .env"成为最简配置入口——把插件需要的配置（如
 * BREEZE_API_KEY / BREEZE_VOICE_ID）放在项目根 .env 即可生效，且该文件被
 * .gitignore 忽略，不会上传。
 *
 * 规则：
 * - 支持 KEY=VALUE、export KEY=VALUE、# 注释、单/双引号包裹
 * - 只填补 process.env 中“未设置或为空”的键，绝不覆盖已有值
 *   （因此 $DSH_HOME/.env 已注入的 DSH 核心变量优先级更高）
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface EnvLoadResult {
  /** 实际被读取并填补了变量的文件 */
  files: string[];
  /** 被填补的键名（不含值） */
  keys: string[];
}

/** 解析 .env 文本为键值对（纯函数，便于单测） */
export function parseEnvContent(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] as string;
    let value = (match[2] ?? '').trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      // 找到与开头匹配的结束引号（双引号内允许 \" 转义），其后的内容（如行内注释）忽略
      let end = -1;
      for (let i = 1; i < value.length; i++) {
        if (value[i] === quote && !(quote === '"' && value[i - 1] === '\\')) {
          end = i;
          break;
        }
      }
      if (end > 0) {
        let inner = value.slice(1, end);
        if (quote === '"') {
          inner = inner.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
        value = inner;
      } else {
        // 没有结束引号：按未加引号处理，去掉行内注释
        const hash = value.indexOf(' #');
        if (hash >= 0) value = value.slice(0, hash).trim();
      }
    } else {
      // 去掉行内注释（未加引号且空格后的 #）
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** 依次读取若干文件，把缺失的键补进 env（默认 process.env） */
export function loadEnvFiles(paths: string[], env: NodeJS.ProcessEnv = process.env): EnvLoadResult {
  const files: string[] = [];
  const keys: string[] = [];

  for (const path of paths) {
    if (!path || !existsSync(path)) continue;
    let parsed: Record<string, string>;
    try {
      parsed = parseEnvContent(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    let used = false;
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined || env[key] === '') {
        env[key] = value;
        if (!keys.includes(key)) keys.push(key);
        used = true;
      }
    }
    if (used) files.push(path);
  }

  return { files, keys };
}

/**
 * 加载项目相关 .env：
 * - `DSH_QQBOT_ENV_FILE` 指定的文件（最高优先）
 * - `<cwd>/.env`（项目根）
 * - `<packageRoot>/.env`（插件包目录，未被覆盖时兜底）
 */
export function loadProjectEnv(cwd: string, packageRoot?: string): EnvLoadResult {
  const candidates: string[] = [];
  if (process.env.DSH_QQBOT_ENV_FILE) candidates.push(process.env.DSH_QQBOT_ENV_FILE);
  candidates.push(join(cwd, '.env'));
  if (packageRoot) candidates.push(join(packageRoot, '.env'));

  const seen = new Set<string>();
  const unique = candidates.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
  return loadEnvFiles(unique);
}
