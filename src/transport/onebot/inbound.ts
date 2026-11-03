/**
 * OneBot v11 入站消息归一化（纯函数，便于单测）
 */
import type { ImQQBotConfig } from '../../config.js';
import type { ReplyTarget } from '../../types.js';

export interface OneBotSegment {
  type: string;
  data?: Record<string, unknown>;
}

export interface OneBotSenderInfo {
  user_id?: number;
  nickname?: string;
  card?: string;
}

export interface OneBotMessageEvent {
  post_type?: string;
  message_type?: 'private' | 'group';
  sub_type?: string;
  message_id?: number;
  user_id?: number;
  group_id?: number;
  self_id?: number;
  raw_message?: string;
  message?: string | OneBotSegment[];
  sender?: OneBotSenderInfo;
  time?: number;
  [key: string]: unknown;
}

const CQ_IMAGE = /\[CQ:image[^\]]*\]/g;
const CQ_RECORD = /\[CQ:record[^\]]*\]/g;
const CQ_AT = /\[CQ:at,qq=[^\]]*\]/g;
const CQ_ANY = /\[CQ:[^\]]*\]/g;

/** 解析 message 字段（数组或 CQ 码字符串）为段数组 */
export function parseSegments(message: string | OneBotSegment[] | undefined): OneBotSegment[] {
  if (!message) return [];
  if (typeof message === 'string') {
    const text = message
      .replace(CQ_IMAGE, '[图片]')
      .replace(CQ_RECORD, '[语音]')
      .replace(CQ_AT, '')
      .replace(CQ_ANY, '');
    return [{ type: 'text', data: { text } }];
  }
  return message.map((seg) => ({ type: seg.type, data: seg.data ?? {} }));
}

/** 提取可读文本（文本 + 媒体/表情占位符 + @） */
export function extractText(segments: OneBotSegment[]): string {
  const parts: string[] = [];
  for (const seg of segments) {
    const data = seg.data ?? {};
    switch (seg.type) {
      case 'text':
        parts.push(String(data.text ?? ''));
        break;
      case 'image':
        parts.push('[图片]');
        break;
      case 'record':
        parts.push('[语音]');
        break;
      case 'face':
        parts.push('[表情]');
        break;
      case 'at': {
        const qq = String(data.qq ?? '');
        if (qq && qq !== 'all') parts.push(`@${qq}`);
        break;
      }
      default:
        break;
    }
  }
  return parts.join('').replace(/[ \t]+/g, ' ').trim();
}

/** 群聊是否 @ 了机器人 */
export function isMentioned(segments: OneBotSegment[], selfId: string): boolean {
  if (!selfId) return false;
  return segments.some((seg) => seg.type === 'at' && String(seg.data?.qq ?? '') === selfId);
}

/** 访问控制（复用官方通道的白名单配置，但条目是 QQ 号 / 群号） */
export function shouldAccept(
  config: Pick<ImQQBotConfig, 'access'>,
  event: OneBotMessageEvent,
  isGroup: boolean,
): boolean {
  const mode = isGroup ? config.access.groupMode : config.access.c2cMode;
  const list = isGroup ? config.access.groupAllow : config.access.c2cAllow;
  const id = String(isGroup ? event.group_id : event.user_id);
  if (mode === 'disabled') return false;
  if (mode === 'open') return true;
  return list.includes(id);
}

/** 归一化回复目标：targetId = 群号 / 用户 QQ 号 */
export function normalizeTarget(event: OneBotMessageEvent): ReplyTarget {
  const isGroup = event.message_type === 'group';
  return {
    scope: isGroup ? 'group' : 'c2c',
    targetId: isGroup ? String(event.group_id) : String(event.user_id),
    msgId: event.message_id != null ? String(event.message_id) : undefined,
  };
}

/** 组装交给 DSH Agent 的文本（群聊带发送者标签） */
export function buildInboundText(
  event: OneBotMessageEvent,
  segments: OneBotSegment[],
  isGroup: boolean,
): string {
  const text = extractText(segments);
  if (!isGroup) return text;
  const sender = event.sender;
  const name = sender?.card || sender?.nickname || String(event.user_id ?? '');
  return `[${name} (${event.user_id ?? ''})] ${text}`.trim();
}
