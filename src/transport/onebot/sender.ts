/**
 * OneBotSender — 实现出站层的 QQBotSender 接口
 *
 * 这样现有的 OutboundBuffer / createOutboundHandler（流式、重试、切分）
 * 可以原样复用到 OneBot 通道，无需感知协议差异。
 */
import type { ReplyTarget } from '../../types.js';
import type { QQBotSender } from '../outbound-buffer.js';
import type { OneBotApi } from './api.js';

export class OneBotSender implements QQBotSender {
  constructor(private readonly api: OneBotApi) {}

  async sendMarkdown(target: ReplyTarget, content: string): Promise<unknown> {
    const id = Number(target.targetId);
    if (!Number.isFinite(id)) throw new Error('无效的 OneBot 目标 ID');
    return target.scope === 'group'
      ? this.api.sendGroupMsg(id, content)
      : this.api.sendPrivateMsg(id, content);
  }

  /** 发送语音条（供情绪语音链路使用） */
  async sendVoice(target: ReplyTarget, file: string): Promise<unknown> {
    const id = Number(target.targetId);
    if (!Number.isFinite(id)) throw new Error('无效的 OneBot 目标 ID');
    return target.scope === 'group'
      ? this.api.sendRecord('group', id, file)
      : this.api.sendRecord('c2c', id, file);
  }
}
