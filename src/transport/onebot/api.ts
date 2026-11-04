/**
 * OneBot v11 常用 action 封装
 *
 * 发送类 action 带“连接类错误”重试（未连接 / 超时 / 关闭），业务错误
 * （retcode≠0）不重试，避免重复发送或掩盖配置问题。
 */
import type { OneBotClient } from './client.js';
import type { OneBotSegment } from './inbound.js';

export interface OneBotLoginInfo {
  user_id: number;
  nickname: string;
}

function isConnError(message: string): boolean {
  return /未连接|超时|closed|关闭|ECONN|socket|websocket|网络/i.test(message);
}

export class OneBotApi {
  constructor(private readonly client: OneBotClient) {}

  call(action: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
    return this.client.call(action, params, timeoutMs);
  }

  /** 连接类错误指数退避重试；业务错误立即抛出 */
  private async withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        if (!isConnError(message)) throw err;
        if (attempt < retries) {
          await new Promise<void>((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  sendPrivateMsg(userId: number, text: string): Promise<unknown> {
    return this.withRetry(() =>
      this.call('send_private_msg', {
        user_id: userId,
        message: [{ type: 'text', data: { text } }],
      }),
    );
  }

  sendGroupMsg(groupId: number, text: string): Promise<unknown> {
    return this.withRetry(() =>
      this.call('send_group_msg', {
        group_id: groupId,
        message: [{ type: 'text', data: { text } }],
      }),
    );
  }

  /** 发送语音（record 段）；file 支持本地路径 / base64:// / http(s):// */
  sendRecord(scope: 'c2c' | 'group', id: number, file: string): Promise<unknown> {
    const message: OneBotSegment[] = [{ type: 'record', data: { file } }];
    return this.withRetry(() =>
      scope === 'group'
        ? this.call('send_group_msg', { group_id: id, message })
        : this.call('send_private_msg', { user_id: id, message }),
    );
  }

  sendSegments(scope: 'c2c' | 'group', id: number, segments: OneBotSegment[]): Promise<unknown> {
    return this.withRetry(() =>
      scope === 'group'
        ? this.call('send_group_msg', { group_id: id, message: segments })
        : this.call('send_private_msg', { user_id: id, message: segments }),
    );
  }

  getLoginInfo(): Promise<OneBotLoginInfo> {
    return this.call('get_login_info', {}) as Promise<OneBotLoginInfo>;
  }
}
