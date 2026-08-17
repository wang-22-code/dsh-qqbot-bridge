/**
 * 出站处理器 — dsh session/event → QQ 消息发送
 *
 * 回合级串行：同一 session 的上一回合 finalize 链未结束前，
 * 新回合的增量发送会等待其完成，避免跨回合消息乱序。
 */
import type { SessionManager, SessionRecord } from '../session/index.js';
import type { ImQQBotConfig } from '../config.js';
import type { Logger, ReplyTarget } from '../types.js';
import { OutboundBuffer, type QQBotSender, type OutboundOptions } from './outbound-buffer.js';

export type { QQBotSender } from './outbound-buffer.js';

/** dsh SessionEvent 简化类型 */
export interface SessionEvent {
  type: string;
  data: Record<string, unknown>;
}

/** dsh Session 简化类型 */
export interface SessionLike {
  header: { id: string };
}

/** 回合失败时发给用户的固定文案（不含内部错误细节，避免信息泄露） */
const TURN_ERROR_NOTICE = '⚠️ 本轮处理出错，请重试。';

/**
 * 创建出站事件处理器
 *
 * 返回一个 handler 函数，应注册到 ctx.on('session/event', handler)
 */
export function createOutboundHandler(
  manager: SessionManager,
  bot: QQBotSender,
  config: ImQQBotConfig,
  logger: Logger,
): (session: SessionLike, event: SessionEvent) => void {
  const buffers = new Map<string, OutboundBuffer>();
  const settling = new Map<string, Promise<void>>();
  const delivered = new Set<string>();
  const limit = config.textChunkLimit;

  const options: OutboundOptions = {
    flushIntervalMs: config.streamFlushIntervalMs,
    maxRetries: config.sendMaxRetries,
    retryBaseMs: config.sendRetryBaseMs,
  };

  return (session: SessionLike, event: SessionEvent) => {
    const sessionId = session.header.id;
    const record = manager.findBySessionId(sessionId);
    if (!record) return;

    if (config.debug && ['assistant/chunk', 'assistant/message', 'turn/end'].includes(event.type)) {
      console.log(`[im-qqbot] [outbound] DSH event=${event.type}`);
    }

    switch (event.type) {
      case 'assistant/chunk': {
        handleChunk(sessionId, record, event, buffers, settling, bot, limit, options, logger);
        break;
      }

      case 'assistant/message': {
        void handleMessage(sessionId, record, event, buffers, settling, delivered, bot, limit, options, logger, config.debug);
        break;
      }

      case 'turn/end': {
        const reason = (event.data as {
          reason?: { kind?: string; error?: { message?: string; code?: string } };
        }).reason;
        if (reason?.kind === 'error') {
          const detail = reason.error?.message ?? reason.error?.code ?? 'unknown DSH error';
          logger.error(`im-qqbot: DSH turn failed: ${detail}`);
          if (config.debug) console.error(`[im-qqbot] [outbound] DSH turn failed: ${detail}`);
        }
        handleTurnEnd(sessionId, record, buffers, settling, delivered, bot, reason?.kind === 'error');
        break;
      }
    }
  };
}

/** 处理流式文本增量 */
function handleChunk(
  sessionId: string,
  record: SessionRecord,
  event: SessionEvent,
  buffers: Map<string, OutboundBuffer>,
  settling: Map<string, Promise<void>>,
  bot: QQBotSender,
  limit: number,
  options: OutboundOptions,
  logger: Logger,
): void {
  const chunk = (event.data as { chunk?: { type?: string; text?: string } }).chunk;
  if (!chunk || chunk.type !== 'text-delta' || !chunk.text) return;

  let buffer = buffers.get(sessionId);
  if (!buffer) {
    buffer = new OutboundBuffer(record, bot, limit, logger, {
      ...options,
      onGiveUp: () => {
        void bot.sendMarkdown(record.replyTarget, '⚠️ 部分回复发送失败（网络或平台限流），可重发消息重新生成。')
          .catch(() => {});
      },
    });
    buffers.set(sessionId, buffer);
    // 首个 chunk 前先等上一回合 finalize 结束，保证回合间消息有序
    void waitSettledChain(settling, sessionId).then(() => {
      // 等待期间 buffer 可能已被 turn/end 清理，重新校验
      if (buffers.get(sessionId) !== buffer) return;
      buffer!.append(chunk.text!);
    });
    return;
  }

  buffer.append(chunk.text);
}

/** 等待某 session 上一回合 settle 链（无则立即返回） */
async function waitSettledChain(
  settling: Map<string, Promise<void>>,
  sessionId: string,
): Promise<void> {
  const prev = settling.get(sessionId);
  if (prev) await prev.catch(() => {});
}

/** 处理完整 assistant 消息 */
async function handleMessage(
  sessionId: string,
  record: SessionRecord,
  event: SessionEvent,
  buffers: Map<string, OutboundBuffer>,
  settling: Map<string, Promise<void>>,
  delivered: Set<string>,
  bot: QQBotSender,
  limit: number,
  options: OutboundOptions,
  logger: Logger,
  debug: boolean,
): Promise<void> {
  const message = event.data as { message?: { content?: Array<{ type: string; text?: string }> } };
  const blocks = message?.message?.content;
  if (!blocks || !Array.isArray(blocks)) return;

  const textParts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      textParts.push(block.text);
    }
  }

  const fullText = textParts.join('\n');
  if (!fullText.trim()) return;

  const buffer = buffers.get(sessionId);
  if (buffer) {
    // 增量流式已送达部分不重发；finalizeWith 内部按 sentChars 对账，
    // 只补发权威全文的未送达尾部（避免「好的…」先流式 flush、又被全文重发）。
    delivered.add(sessionId);
    const chain = buffer.finalizeWith(fullText);
    settling.set(sessionId, chain);
    await chain;
    buffers.delete(sessionId);
    return;
  }

  // 无流式 buffer 的回合（interval=0 或纯非流式事件）：灌入新 buffer 统一走重试路径
  await waitSettledChain(settling, sessionId);
  const fallback = new OutboundBuffer(record, bot, limit, logger, {
    ...options,
    onGiveUp: () => {
      void bot.sendMarkdown(record.replyTarget, '⚠️ 部分回复发送失败（网络或平台限流），可重发消息重新生成。')
        .catch(() => {});
    },
  });
  buffers.set(sessionId, fallback);
  fallback.append(fullText);
  delivered.add(sessionId);
  const chain = fallback.finalize();
  settling.set(sessionId, chain);
  await chain;
  buffers.delete(sessionId);
  if (debug) console.log('[im-qqbot] [outbound] QQ reply sent');
}

/** 处理轮次结束：终结 buffer + 未送达完整回复时通知用户 */
function handleTurnEnd(
  sessionId: string,
  record: SessionRecord,
  buffers: Map<string, OutboundBuffer>,
  settling: Map<string, Promise<void>>,
  delivered: Set<string>,
  bot: QQBotSender,
  turnFailed: boolean,
): void {
  const alreadyDelivered = delivered.delete(sessionId);
  const buffer = buffers.get(sessionId);
  if (!buffer) {
    // 完整回复已送达时，turn/end 的 error 只是尾随噪音（错误已进日志）
    if (turnFailed && !alreadyDelivered) notifyTurnError(record.replyTarget, bot);
    return;
  }

  const chain = buffer.finalize().then(() => {
    buffers.delete(sessionId);
    if (turnFailed && !alreadyDelivered) notifyTurnError(record.replyTarget, bot);
  });
  settling.set(sessionId, chain);
}

function notifyTurnError(target: ReplyTarget, bot: QQBotSender): void {
  bot.sendMarkdown(target, TURN_ERROR_NOTICE).catch((err: unknown) => {
    // 通知本身失败只能记日志；不重试（避免与下一回合发送争用）
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[im-qqbot] [outbound] turn error notice failed: ${detail}`);
  });
}
