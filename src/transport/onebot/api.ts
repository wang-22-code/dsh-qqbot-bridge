/**
 * OneBot v11 常用 action 封装
 */
import type { OneBotClient } from './client.js';
import type { OneBotSegment } from './inbound.js';

export interface OneBotLoginInfo {
  user_id: number;
  nickname: string;
}

export class OneBotApi {
  constructor(private readonly client: OneBotClient) {}

  call(action: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<unknown> {
    return this.client.call(action, params, timeoutMs);
  }

  sendPrivateMsg(userId: number, text: string): Promise<unknown> {
    return this.call('send_private_msg', {
      user_id: userId,
      message: [{ type: 'text', data: { text } }],
    });
  }

  sendGroupMsg(groupId: number, text: string): Promise<unknown> {
    return this.call('send_group_msg', {
      group_id: groupId,
      message: [{ type: 'text', data: { text } }],
    });
  }

  /** 发送语音（record 段）；file 支持本地路径 / base64:// / http(s):// */
  sendRecord(scope: 'c2c' | 'group', id: number, file: string): Promise<unknown> {
    const message: OneBotSegment[] = [{ type: 'record', data: { file } }];
    return scope === 'group'
      ? this.call('send_group_msg', { group_id: id, message })
      : this.call('send_private_msg', { user_id: id, message });
  }

  sendSegments(scope: 'c2c' | 'group', id: number, segments: OneBotSegment[]): Promise<unknown> {
    return scope === 'group'
      ? this.call('send_group_msg', { group_id: id, message: segments })
      : this.call('send_private_msg', { user_id: id, message: segments });
  }

  getLoginInfo(): Promise<OneBotLoginInfo> {
    return this.call('get_login_info', {}) as Promise<OneBotLoginInfo>;
  }
}
