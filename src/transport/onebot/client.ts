/**
 * OneBot v11 正向 WebSocket 客户端（NapCat 等网关）
 *
 * 插件作为客户端主动连接 `ws://127.0.0.1:<port>`，收事件、发 action。
 * 依赖 Node 22 内置全局 WebSocket（undici），无需额外依赖。
 *
 * 特性：
 * - access_token 通过查询参数传递（OneBot v11 标准做法）
 * - action/echo 请求-响应关联
 * - 断线按指数退避重连，封顶 reconnectMaxMs
 */
import type { Logger } from '../../types.js';

interface MinimalWebSocket {
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  send(data: string): void;
  close(): void;
  readonly readyState: number;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface OneBotClientOptions {
  url: string;
  accessToken?: string;
  reconnectMaxMs?: number;
  logger: Logger;
}

export class OneBotClient {
  private ws: MinimalWebSocket | null = null;
  private closed = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, PendingCall>();
  private echoSeq = 0;

  /** 收到非响应事件时的回调（post_type 事件） */
  onEvent: ((event: Record<string, unknown>) => void) | null = null;

  constructor(private readonly opts: OneBotClientOptions) {}

  get isOpen(): boolean {
    return this.ws?.readyState === 1;
  }

  /** 开始连接；首次连上后 resolve，失败 reject（之后仍会自动重连） */
  start(): Promise<void> {
    this.closed = false;
    return this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending(new Error('OneBot 客户端已关闭'));
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  /** 强制重建连接（心跳/健康检查失败时调用，会触发自动重连） */
  forceReconnect(): void {
    if (this.closed) return;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  /** 调用 OneBot action 并等待 echo 响应 */
  call(action: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.ws || !this.isOpen) {
        reject(new Error('OneBot 未连接'));
        return;
      }
      const echo = `echo-${++this.echoSeq}`;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot 调用超时: ${action}`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ── 内部实现 ──

  private endpoint(): string {
    const token = this.opts.accessToken;
    if (!token) return this.opts.url;
    const sep = this.opts.url.includes('?') ? '&' : '?';
    return `${this.opts.url}${sep}access_token=${encodeURIComponent(token)}`;
  }

  private connect(): Promise<void> {
    const WS = (globalThis as unknown as { WebSocket?: new (url: string) => MinimalWebSocket }).WebSocket;
    if (!WS) {
      return Promise.reject(new Error('全局 WebSocket 不可用（需要 Node 22+）'));
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let ws: MinimalWebSocket;
      try {
        ws = new WS(this.endpoint());
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;

      ws.addEventListener('open', () => {
        settled = true;
        this.attempts = 0;
        this.opts.logger.info(`[onebot] WebSocket 已连接 ${this.opts.url}`);
        resolve();
      });

      ws.addEventListener('message', (ev: unknown) => {
        const data = (ev as { data?: unknown }).data;
        this.handleRaw(data);
      });

      ws.addEventListener('error', (ev: unknown) => {
        const message =
          (ev as { message?: string }).message ??
          (ev as { error?: { message?: string } }).error?.message ??
          'websocket error';
        this.opts.logger.warn(`[onebot] WebSocket 错误: ${message}`);
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
      });

      ws.addEventListener('close', (ev: unknown) => {
        const code = (ev as { code?: number }).code;
        this.opts.logger.warn(`[onebot] WebSocket 关闭 code=${code ?? '?'}`);
        this.ws = null;
        this.rejectAllPending(new Error('OneBot 连接已关闭'));
        if (!settled) {
          settled = true;
          reject(new Error('websocket closed before open'));
        }
        this.scheduleReconnect();
      });
    });
  }

  private handleRaw(data: unknown): void {
    if (typeof data !== 'string') return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(data) as Record<string, unknown>;
    } catch {
      this.opts.logger.warn('[onebot] 收到非 JSON 数据，已忽略');
      return;
    }

    const echo = obj.echo;
    if (typeof echo === 'string') {
      const pendingCall = this.pending.get(echo);
      if (!pendingCall) return;
      clearTimeout(pendingCall.timer);
      this.pending.delete(echo);
      const retcode = obj.retcode;
      if (typeof retcode === 'number' && retcode !== 0) {
        pendingCall.reject(new Error(`OneBot action 失败 retcode=${retcode} ${String(obj.wording ?? '')}`.trim()));
      } else {
        pendingCall.resolve(obj.data);
      }
      return;
    }

    if (typeof obj.post_type === 'string') {
      this.onEvent?.(obj);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.attempts += 1;
    const max = this.opts.reconnectMaxMs ?? 30000;
    const delay = Math.min(max, 1000 * 2 ** Math.min(this.attempts - 1, 5));
    this.opts.logger.info(`[onebot] ${delay}ms 后重连（第 ${this.attempts} 次）`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        this.opts.logger.warn(`[onebot] 重连失败: ${detail}`);
      });
    }, delay);
  }

  private rejectAllPending(err: Error): void {
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(err);
    }
    this.pending.clear();
  }
}
