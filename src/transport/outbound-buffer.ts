/**
 * OutboundBuffer — 出站文本缓冲
 *
 * 收集流式 chunk 并按可配置间隔增量发送；发送失败按前缀记账保留
 * 未送达内容并指数退避重试。独立文件便于单测。
 *
 * 核心不变式：this.buffer 只含「未确认送达」的内容。
 * flush 按 chunk 前缀记账：第 k 个 chunk 发送失败时，已送达的
 * k-1 个不再重发，buffer 回写为 chunks[k..]，避免用户收到重复消息。
 */
import type { SessionRecord } from '../session/index.js';
import type { Logger, ReplyTarget } from '../types.js';
import { chunkMarkdownText } from './chunker.js';

/** QQ Bot 发送接口 */
export interface QQBotSender {
  sendMarkdown(target: ReplyTarget, content: string): Promise<unknown>;
}

/** 出站发送策略选项（全部可选，缺省保持旧行为） */
export interface OutboundOptions {
  /** 增量下发间隔(ms)；0 = 不自动调度（旧行为，等整条消息） */
  readonly flushIntervalMs: number;
  /** 单段内容发送失败的最大重试次数；0 = 不重试（旧行为） */
  readonly maxRetries: number;
  /** 指数退避基数(ms)：retryBaseMs * 2^(attempt-1) */
  readonly retryBaseMs: number;
  /** 重试耗尽回调（outbound 层用它向用户发提示），每个缓冲生命周期最多触发一次 */
  readonly onGiveUp?: (err: Error) => void;
}

/** 缺省选项：与历史行为完全一致（不自动调度、失败不重试） */
export const DEFAULT_OUTBOUND_OPTIONS: OutboundOptions = {
  flushIntervalMs: 0,
  maxRetries: 0,
  retryBaseMs: 0,
};

const CODE_FENCE_OPEN = /^```/;

export class OutboundBuffer {
  private buffer = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private finalized = false;
  private gaveUp = false;
  private sentChars = 0;
  private inflight: Promise<void> | null = null;
  private finalizePromise: Promise<void> | null = null;
  private readonly options: OutboundOptions;
  private readonly record: SessionRecord;
  private readonly bot: QQBotSender;
  private readonly limit: number;
  private readonly logger: Logger;

  constructor(
    record: SessionRecord,
    bot: QQBotSender,
    limit: number,
    logger: Logger,
    options?: Partial<OutboundOptions>,
  ) {
    this.record = record;
    this.bot = bot;
    this.limit = limit;
    this.logger = logger;
    this.options = { ...DEFAULT_OUTBOUND_OPTIONS, ...options };
  }

  /** 追加文本增量（options.flushIntervalMs > 0 时自动调度增量下发） */
  append(text: string): void {
    if (this.finalized) return;
    this.buffer += text;
    if (this.options.flushIntervalMs > 0) this.scheduleSend(this.options.flushIntervalMs);
  }

  /** 获取当前累积文本 */
  get text(): string {
    return this.buffer;
  }

  /** 本回合已成功送达的字符数（assistant/message 用它对齐全文、避免重发） */
  get deliveredChars(): number {
    return this.sentChars;
  }

  /** 安排延迟发送（throttle：已有定时器时忽略，保证两次发送最小间隔） */
  scheduleSend(delayMs: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
  }

  /** 立即发送当前可发送内容（失败时按退避重试，超出次数保留余量） */
  async flush(): Promise<void> {
    this.inflight = this.doFlush();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  /**
   * 停止自动调度，等待在途发送链完成后做最后一次尝试（幂等）。
   * 最后一轮不做 fence 吸附，保证回合收尾时余量整段送出。
   */
  async finalize(): Promise<void> {
    if (this.finalizePromise) return this.finalizePromise;

    this.finalizePromise = (async () => {
      this.finalized = true;
      this.clearTimer();

      if (this.inflight) {
        await this.inflight.catch(() => {});
      }

      await this.doFlush();
    })();

    return this.finalizePromise;
  }

  /**
   * 以权威全文收尾（幂等）：已通过增量流式送达的部分不再重发，
   * 只补发 fullText 中尚未到达用户的内容；tail 为空时不做任何发送。
   */
  async finalizeWith(fullText: string): Promise<void> {
    this.finalized = true;
    this.clearTimer();
    if (fullText.length > this.sentChars) {
      this.buffer = fullText.slice(this.sentChars);
      return this.finalize();
    }
    this.buffer = '';
    return Promise.resolve();
  }

  /** 取消未发送的定时器并丢弃缓冲 */
  cancel(): void {
    this.clearTimer();
    this.buffer = '';
  }

  // ── 内部实现 ──

  /**
   * 单轮发送：切分可发送前缀 → 逐 chunk 发送并记账。
   * 第 k 个 chunk 失败时回写 chunks[k..] 为新 buffer，指数退避后重试；
   * 超过 maxRetries 触发一次 onGiveUp 并保留余量。
   */
  private async doFlush(): Promise<void> {
    if (this.flushing) return;
    if (!this.buffer.trim()) return;

    this.flushing = true;

    try {
      let attempt = 0;

      for (;;) {
        const sendable = this.takeSendable();
        if (!sendable.trim()) break;

        const chunks = chunkMarkdownText(sendable, this.limit);
        let failedAt = -1;
        let lastErr: Error | null = null;

        for (let i = 0; i < chunks.length; i++) {
          try {
            await this.bot.sendMarkdown(this.record.replyTarget, chunks[i]!);
          } catch (err) {
            failedAt = i;
            lastErr = err instanceof Error ? err : new Error(String(err));
            break;
          }
        }

        if (failedAt === -1) {
          this.consumeSent(sendable.length);
          break;
        }

        // 前缀记账：丢弃已送达前缀（计入 sentChars），只保留未送达余量
        const unsent = chunks.slice(failedAt).join('\n');
        this.sentChars += sendable.length - unsent.length;
        this.buffer = unsent;
        attempt += 1;

        if (attempt > this.options.maxRetries) {
          this.reportGiveUp(lastErr);
          break;
        }

        await this.delay(this.options.retryBaseMs * 2 ** (attempt - 1));
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * 计算增量 flush 的可发送前缀：代码块（``` fence）未配平时，
   * 只发送到最后一个配平边界，未配平余量留在 buffer 等待下次。
   * finalize 的最后一轮不做吸附（与整条切分行为一致）。
   */
  private takeSendable(): string {
    if (!this.finalized) {
      const cut = lastBalancedFenceCut(this.buffer);
      if (cut > 0) return this.buffer.slice(0, cut);
    }
    return this.buffer;
  }

  /** 消费已送达前缀，buffer 只留未发送余量；sentChars 记录到达用户的累计字符数 */
  private consumeSent(sentLength: number): void {
    this.sentChars += sentLength;
    this.buffer = this.buffer.slice(sentLength);
  }

  private reportGiveUp(err: Error | null): void {
    if (this.gaveUp) return;
    this.gaveUp = true;
    this.logger.error(
      `im-qqbot: sendMarkdown gave up after ${this.options.maxRetries} retries: ${err?.message ?? 'unknown'}`,
    );
    this.options.onGiveUp?.(err ?? new Error('send failed'));
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * 返回最后一个代码块配平边界之后的位置（可安全增量发送的前缀长度）。
 * fence 总数为奇数（有未闭合代码块）时返回配平部分；无任何配平边界返回 0。
 */
function lastBalancedFenceCut(text: string): number {
  let fenceCount = 0;
  let lastBalanced = -1;
  const lines = text.split('\n');
  let offset = 0;

  for (const line of lines) {
    if (CODE_FENCE_OPEN.test(line)) fenceCount += 1;
    if (fenceCount % 2 === 0) lastBalanced = offset + line.length;
    offset += line.length + 1;
  }

  return lastBalanced + 1;
}
