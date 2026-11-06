import { randomBytes } from 'node:crypto';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { SessionManager, SessionRecord, DshAgent } from './session/index.js';
import type { Logger, ReplyTarget } from './types.js';

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

export interface ApprovalRequestLike {
  readonly agent: DshAgent;
  readonly toolName: string;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

export interface ApprovalSender {
  sendMarkdown(target: ReplyTarget, content: string): Promise<unknown>;
}

interface PendingApproval {
  record: SessionRecord;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface ParsedApprovalCommand {
  outcome: 'allowed-once' | 'rejected';
  code: string;
}

/** Parse only explicit approval commands; ordinary chat must continue to DSH. */
export function parseApprovalCommand(content: string): ParsedApprovalCommand | null {
  const normalized = content.trim();
  const match = normalized.match(/^\/(approve|allow|deny|reject)\s+([A-Z0-9]{6})$/i)
    ?? normalized.match(/^(允许|同意|拒绝|不同意)\s+([A-Z0-9]{6})$/i);
  if (!match) return null;

  const action = match[1]!.toLowerCase();
  return {
    outcome: ['approve', 'allow', '允许', '同意'].includes(action) ? 'allowed-once' : 'rejected',
    code: match[2]!.toUpperCase(),
  };
}

/** QQ-backed, one-shot DSH approval answerer. */
export class QqApprovalController {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly manager: SessionManager,
    private readonly sender: ApprovalSender,
    private readonly logger: Logger,
    private readonly timeoutMs: number,
  ) {}

  async request(
    req: ApprovalRequestLike,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const record = this.manager.findByAgent(req.agent);
    if (!record) return next();
    if (req.signal?.aborted) return 'cancelled';

    let code = '';
    do code = randomBytes(3).toString('hex').toUpperCase();
    while (this.pending.has(code));

    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => this.settle(code, 'rejected'), this.timeoutMs);
      const pending: PendingApproval = { record, resolve, timer, signal: req.signal };
      if (req.signal) {
        pending.onAbort = () => this.settle(code, 'cancelled');
        req.signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this.pending.set(code, pending);
    });

    const reason = sanitizeReason(req.reason);
    const seconds = Math.ceil(this.timeoutMs / 1000);
    const prompt = [
      '⚠️ **DSH 权限申请**',
      `工具：${req.toolName}`,
      reason ? `原因：${reason}` : '',
      '',
      `允许本次操作：\`/approve ${code}\``,
      `拒绝本次操作：\`/deny ${code}\``,
      `仅本次有效，${seconds} 秒后自动拒绝。`,
    ].filter(Boolean).join('\n');

    try {
      await this.sender.sendMarkdown(record.replyTarget, prompt);
      this.logger.info(`QQ approval requested: code=${code} tool=${req.toolName}`);
    } catch (err) {
      this.logger.error(`QQ approval prompt failed: ${err instanceof Error ? err.message : String(err)}`);
      this.settle(code, 'unavailable');
    }

    return outcome;
  }

  /** Consume a matching command before it reaches the DSH agent. */
  async handleInbound(mCtx: MiddlewareContext): Promise<boolean> {
    const command = parseApprovalCommand(mCtx.message.content ?? '');
    if (!command) return false;

    const pending = this.pending.get(command.code);
    if (!pending) {
      await this.sender.sendMarkdown(mCtx.replyTarget, '该权限申请不存在或已过期。');
      return true;
    }

    const msg = mCtx.message;
    const sameSender = msg.senderId === pending.record.senderId;
    const samePeer = pending.record.scope === 'c2c'
      ? msg.kind === 'c2c' && msg.senderId === pending.record.peerId
      : msg.kind === 'group' && msg.groupOpenid === pending.record.peerId;

    if (!sameSender || !samePeer) {
      await this.sender.sendMarkdown(mCtx.replyTarget, '你无权处理这项权限申请。');
      return true;
    }

    const settled = this.settle(command.code, command.outcome);
    if (!settled) {
      await this.sender.sendMarkdown(mCtx.replyTarget, '该权限申请不存在或已过期。');
      return true;
    }
    await this.sender.sendMarkdown(
      mCtx.replyTarget,
      command.outcome === 'allowed-once' ? '✅ 已允许本次操作。' : '❌ 已拒绝本次操作。',
    );
    return true;
  }

  dispose(): void {
    for (const code of [...this.pending.keys()]) this.settle(code, 'cancelled');
  }

  private settle(code: string, outcome: ApprovalOutcome): boolean {
    const pending = this.pending.get(code);
    if (!pending) return false;
    this.pending.delete(code);
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    pending.resolve(outcome);
    return true;
  }
}

function sanitizeReason(reason?: string): string {
  if (!reason) return '';
  return reason.replace(/[\r\n]+/g, ' ').trim().slice(0, 800);
}
