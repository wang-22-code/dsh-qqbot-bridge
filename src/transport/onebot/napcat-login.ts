/**
 * NapCat 登录二维码查询辅助
 *
 * NapCat 的登录二维码由它自己的 WebUI 提供；本模块在插件启动时主动去
 * NapCat WebUI 拉取二维码（图片 base64 或 URL），保存为 PNG 并打印路径，
 * 让用户可以直接在插件侧完成扫码登录，而不用手动打开 WebUI。
 *
 * 由于不同 NapCat 版本的 WebUI 接口字段略有差异，这里做宽松解析：
 * 依次尝试 GET/POST `/api/QQLogin/GetQQLoginQrcode`，兼容 data.qrcode /
 * data.url 等常见字段。取不到时给出可读错误，不影响消息通道本身。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../../types.js';

export interface NapCatQrInfo {
  /** 二维码图片 base64（不含 data: 前缀则原样） */
  qrcodeBase64?: string;
  /** 二维码指向的 URL（部分实现直接给 url） */
  qrUrl?: string;
}

export interface NapCatQrFetchOptions {
  webuiUrl: string;
  token?: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  outDir?: string;
  /** 单次请求超时(ms)，默认 10000（避免 WebUI 挂起导致轮询永久阻塞） */
  requestTimeoutMs?: number;
  /** 中止信号（轮询被取消时一并中断在途请求） */
  signal?: AbortSignal;
}

export interface NapCatQrFetchResult extends NapCatQrInfo {
  ok: boolean;
  file?: string;
  message: string;
}

/** 从 NapCat 返回 JSON 中宽松解析二维码字段（纯函数，便于单测） */
export function parseNapCatQrPayload(payload: unknown): NapCatQrInfo {
  const root = (payload ?? {}) as Record<string, unknown>;
  const data = (root.data ?? root) as Record<string, unknown>;
  const qrcode = data.qrcode ?? data.qrCode ?? data.qrcode_image ?? data.image;
  const url = data.url ?? data.qrcodeUrl ?? data.qrUrl;

  const info: NapCatQrInfo = {};
  if (typeof qrcode === 'string' && qrcode) {
    if (/^https?:\/\//.test(qrcode)) info.qrUrl = qrcode;
    else info.qrcodeBase64 = qrcode;
  }
  if (typeof url === 'string' && url) info.qrUrl = url;
  return info;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export async function fetchNapCatQrcode(opts: NapCatQrFetchOptions): Promise<NapCatQrFetchResult> {
  const base = trimSlash(opts.webuiUrl);
  if (!base) return { ok: false, message: '未配置 NapCat WebUI 地址' };

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) return { ok: false, message: '当前运行时不支持 fetch' };

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) {
    headers.authorization = `Bearer ${opts.token}`;
    headers['x-webui-token'] = opts.token;
  }

  const attempts: Array<{ method: 'GET' | 'POST'; path: string }> = [
    { method: 'GET', path: '/api/QQLogin/GetQQLoginQrcode' },
    { method: 'POST', path: '/api/QQLogin/GetQQLoginQrcode' },
  ];

  let lastError = '';
  const requestTimeoutMs = opts.requestTimeoutMs ?? 10000;
  for (const attempt of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const onAbort = (): void => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await fetchImpl(`${base}${attempt.path}`, {
        method: attempt.method,
        headers,
        signal: controller.signal,
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const json = (await res.json()) as unknown;
      const info = parseNapCatQrPayload(json);
      if (!info.qrcodeBase64 && !info.qrUrl) {
        lastError = '响应中未找到二维码字段';
        continue;
      }

      let file: string | undefined;
      if (info.qrcodeBase64) {
        const base64 = info.qrcodeBase64.replace(/^data:image\/[a-zA-Z]+;base64,/, '');
        const dir = opts.outDir ?? tmpdir();
        mkdirSync(dir, { recursive: true });
        file = join(dir, `napcat-qr-${Date.now()}.png`);
        writeFileSync(file, Buffer.from(base64, 'base64'));
      }

      opts.logger.info(
        `[napcat] 已获取登录二维码${file ? `，已保存: ${file}` : ''}${info.qrUrl ? `，URL: ${info.qrUrl}` : ''}`,
      );
      return { ok: true, ...info, ...(file ? { file } : {}), message: '已获取登录二维码' };
    } catch (err) {
      lastError = controller.signal.aborted
        ? '请求超时或被中止'
        : err instanceof Error
          ? err.message
          : String(err);
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    }
  }

  return { ok: false, message: `获取 NapCat 登录二维码失败：${lastError || '未知错误'}` };
}

export interface NapCatPollOptions extends NapCatQrFetchOptions {
  /** 轮询间隔(ms)，默认 15000 */
  intervalMs?: number;
  /** 总超时(ms)，默认 300000 */
  timeoutMs?: number;
  /** 检查是否已登录（如调用 OneBot get_login_info） */
  isLoggedIn?: () => Promise<boolean>;
  /** 中止轮询 */
  signal?: AbortSignal;
}

/**
 * 轮询登录：反复获取/刷新登录二维码，并检查登录状态，
 * 直到登录成功 / 超时 / 被中止。适合"插件内扫码登录"场景。
 */
export async function pollNapCatLogin(
  opts: NapCatPollOptions,
): Promise<{ ok: boolean; message: string }> {
  const intervalMs = opts.intervalMs ?? 15000;
  const timeoutMs = opts.timeoutMs ?? 300000;
  const startedAt = Date.now();
  let lastQrSign = '';

  while (Date.now() - startedAt < timeoutMs) {
    if (opts.signal?.aborted) return { ok: false, message: '已中止轮询' };

    if (opts.isLoggedIn) {
      const loggedIn = await opts.isLoggedIn().catch(() => false);
      if (loggedIn) {
        opts.logger.info('[napcat] 检测到已登录');
        return { ok: true, message: '已登录' };
      }
    }

    const result = await fetchNapCatQrcode(opts);
    if (result.ok) {
      const sign = result.file ?? result.qrUrl ?? '';
      if (sign && sign !== lastQrSign) {
        lastQrSign = sign;
        opts.logger.info(`[napcat] 登录二维码已更新: ${sign}`);
      }
    } else {
      opts.logger.warn(`[napcat] ${result.message}`);
    }

    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }

  return { ok: false, message: '等待 NapCat 登录超时' };
}
