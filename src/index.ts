/**
 * dsh-im-qqbot — QQ Bot IM channel plugin for deepseek-harness
 *
 * Cordis 插件入口。将 QQ 消息平台作为 dsh 的前端协议驱动。
 * 复用 @tencent-connect/qqbot-nodejs SDK 全套中间件链。
 */
import type { Context } from '@deepseek-ai/cordis';
import {
  QQBot,
  errorHandler,
  messageFilter,
  accessPolicy,
  mentionGate,
  contentSanitizer,
  rateLimiter,
  slashCommand,
  concurrencyGuard,
  typingIndicator,
  quoteRef,
  historyBuffer,
  envelopeFormatter,
  MemoryHistoryStore,
} from '@tencent-connect/qqbot-nodejs';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';

import { ConfigSchema, type ImQQBotConfig } from './config.js';
import { SessionManager, type DshAgentRegistry } from './session/index.js';
import { bootstrapOneBot } from './channel/onebot.js';
import { handleInbound, createOutboundHandler } from './transport/index.js';
import { buildCommandList } from './commands/index.js';
import { resolveEnv, buildUserAgent } from './shared/index.js';
import { runQrSetup, persistCredentialsToDshEnv } from './setup.js';
import { validateSecurityConfig } from './security.js';
import { QqApprovalController, type ApprovalRequestLike, type ApprovalOutcome } from './approval.js';
import { MemoryStore, handleMemoryCommand, autoCapture, keywordExtractor, defaultMemoryRoot } from './memory/index.js';
import { synthesize, detectEmotion } from './voice/index.js';
import type { Logger, ReplyTarget } from './types.js';

// ── Cordis 插件元数据 ──
export const name = 'im-qqbot';
export const inject = ['agents', 'approval'];
export const Config = ConfigSchema;

export type { ImQQBotConfig } from './config.js';

// ── 插件主体 ──
export async function apply(ctx: Context, config: ImQQBotConfig): Promise<void> {
  const agents = (ctx as unknown as Record<string, unknown>).agents as DshAgentRegistry;
  const logger: Logger = ((ctx as unknown as Record<string, unknown>).logger as Logger) ?? console;

  console.log('[im-qqbot] apply() called');

  // ── OneBot / NapCat 个人号通道 ──
  if (config.channel === 'onebot') {
    const resolvedOneBot: ImQQBotConfig = { ...config, appId: config.onebot.selfId || 'onebot' };
    await bootstrapOneBot(ctx, agents, resolvedOneBot, logger);
    return;
  }

  let appId = resolveEnv(config.appId, 'QQBOT_APPID');
  let appSecret = resolveEnv(config.appSecret, 'QQBOT_SECRET');

  // ── 凭据缺失时唤起扫码绑定 ──
  if (!appId || !appSecret) {
    logger.info('凭据未配置，尝试扫码绑定...');
    const credentials = await runQrSetup();

    if (!credentials) {
      logger.error('无法获取 QQ Bot 凭据，插件未启动');
      return;
    }

    // 写入 DSH_HOME/.env，不把 Secret 放进 cordis.patch.yml
    persistCredentialsToDshEnv(credentials, undefined, logger);

    // 写入环境变量供热更新后的下次 apply 读取
    process.env.QQBOT_APPID = credentials.appId;
    process.env.QQBOT_SECRET = credentials.appSecret;

    appId = credentials.appId;
    appSecret = credentials.appSecret;
  }

  const resolvedConfig: ImQQBotConfig = { ...config, appId, appSecret };

  await bootstrap(ctx, agents, resolvedConfig, logger);
}

async function bootstrap(
  ctx: Context,
  agents: DshAgentRegistry,
  config: ImQQBotConfig,
  logger: Logger,
): Promise<void> {
  const security = validateSecurityConfig(config);
  for (const warning of security.warnings) {
    logger.warn(`[security] ${warning}`);
    // DSH 的 headless profile 可能隐藏 warn 日志；安全拒绝原因必须可见，
    // 否则空白名单看起来会像机器人离线。
    console.warn(`[im-qqbot] [security] ${warning}`);
  }
  if (security.errors.length > 0) {
    for (const error of security.errors) logger.error(`[security] ${error}`);
    logger.error('[security] 配置未通过安全检查，QQ Bot 未启动');
    return;
  }
  config.cwd = security.cwd;

  const manager = new SessionManager(ctx, agents, config, logger);
  const memoryStore = config.memory.enabled
    ? new MemoryStore(config.memory.dir || defaultMemoryRoot())
    : undefined;

  // ── 初始化 QQ Bot SDK ──
  const userAgent = buildUserAgent();
  const sdkLogger = config.debug ? {
    info: (message: string) => console.log(`[im-qqbot] [gateway] ${message}`),
    warn: (message: string) => console.warn(`[im-qqbot] [gateway] ${message}`),
    error: (message: string) => console.error(`[im-qqbot] [gateway] ${message}`),
    // SDK 的 dispatch debug 默认带完整 payload（含聊天正文）。诊断时只保留事件名。
    debug: (message: string) => {
      const safeMessage = message
        .replace(/ payload=.*/, '')
        .replace(/(\/v2\/users\/)[^/]+(\/messages)/, '$1<redacted>$2')
        .replace(/(\/v2\/groups\/)[^/]+(\/messages)/, '$1<redacted>$2')
        .replace(/(>>> Body:).*/, '$1 <redacted>')
        .replace(/(<<< Body:).*/, '$1 <redacted>');
      console.log(`[im-qqbot] [gateway-debug] ${safeMessage}`);
    },
  } : logger;
  const bot = new QQBot({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: 'websocket',
    userAgent,
    logger: sdkLogger,
  } as ConstructorParameters<typeof QQBot>[0]);
  logger.info(`QQBot SDK initialized (UA: ${userAgent})`);
  const approvalController = new QqApprovalController(
    manager,
    bot,
    logger,
    config.approvalTimeoutMs,
  );

  // ══════════════════════════════════════════════════════════════
  // SDK 中间件链（洋葱模型，按执行顺序编排）
  // ══════════════════════════════════════════════════════════════

  // 1. 错误兜底（最外层洋葱皮）
  bot.use(errorHandler());

  // 2. 消息过滤：bot 回声 + 消息去重
  bot.use(messageFilter({ skipSelfEcho: false }));

  // 首次配对白名单时必须在 accessPolicy 之前输出，否则消息会先被拦截。
  // DSH 默认会过滤 SDK 的 info/debug 日志，因此显式 debug 模式使用
  // console 输出；不记录消息正文、附件或凭据。
  if (config.debug) {
    bot.use(async (mCtx: MiddlewareContext, next: () => Promise<void>) => {
      const msg = mCtx.message;
      console.log(
        `[im-qqbot] [pairing-debug] inbound kind=${msg.kind} senderOpenId=${msg.senderId}`,
      );
      await next();
    });
  }

  // 3. 访问控制（白名单/开放/禁用）
  bot.use(accessPolicy({
    c2c: {
      mode: config.access.c2cMode,
      allow: config.access.c2cAllow,
    },
    group: {
      mode: config.access.groupMode,
      allow: config.access.groupAllow,
    },
    onBlock: (_mCtx, reason) => {
      if (config.debug) {
        console.log(`[im-qqbot] [access-debug] Access blocked: ${reason}`);
      }
    },
  }));

  // ── 记忆命令（/memory）：在白名单之后、审批与转发之前消费 ──
  if (memoryStore) {
    bot.use(async (mCtx: MiddlewareContext, next: () => Promise<void>) => {
      const msg = mCtx.message as unknown as {
        kind?: string;
        senderId: string;
        groupOpenid?: string;
        messageId?: string;
        content?: string;
      };
      const scope: 'c2c' | 'group' = msg.kind === 'group' ? 'group' : 'c2c';
      const peerId = scope === 'group' ? (msg.groupOpenid ?? msg.senderId) : msg.senderId;
      const peerKey = `official:${scope}:${peerId}`;
      const text = (msg.content ?? '').trim();
      const cmd = handleMemoryCommand(memoryStore, peerKey, text);
      if (cmd.handled) {
        const replyTarget: ReplyTarget = { scope, targetId: peerId, msgId: msg.messageId };
        await bot.sendMarkdown(replyTarget, cmd.reply ?? '');
        mCtx.stop('memory command consumed');
        return;
      }
      autoCapture(memoryStore, peerKey, text);
      await next();
    });
  }

  // QQ 审批回复必须在历史、斜杠命令和 Agent 转发之前消费。
  if (config.enableApprovals) {
    bot.use(async (mCtx: MiddlewareContext, next: () => Promise<void>) => {
      if (await approvalController.handleInbound(mCtx)) {
        mCtx.stop('approval response consumed');
        return;
      }
      await next();
    });
  }

  // 4. 群历史缓冲 — 放在门控之前，确保所有消息（含未 @bot）都计入上下文
  const historyStore = new MemoryHistoryStore();
  bot.use(historyBuffer({
    limit: config.historyLimit,
    store: historyStore,
    recordOnSkip: true,
  }));

  // 5. 群聊 @bot 门控
  bot.use(mentionGate({
    requireMentionInGroup: config.requireMention,
  }));

  // 6. 内容清洗（去 @marker、表情标签、多余空白）
  bot.use(contentSanitizer({
    parseFaceTags: true,
  }));

  // 7. 三层限流（sender / group / global）
  bot.use(rateLimiter());

  // 8. 斜杠命令（在 concurrencyGuard 之前，命令匹配后不排队直接响应）
  const slash = slashCommand({
    autoHelp: true,
    commands: buildCommandList({ manager, config }),
  });
  bot.use(slash.middleware);

  // 9. 并发串行 + 消息合并（同 peer 排队，避免 session 冲突）
  bot.use(concurrencyGuard({
    strategy: 'merge',
    maxQueue: config.maxQueue,
    maxProcessingMs: config.processingTimeoutMs,
    urgentPredicate: (mCtx: MiddlewareContext) => {
      return (mCtx.message.content ?? '').trim() === '/bot-stop';
    },
  }));

  // 10. C2C 输入状态指示
  bot.use(typingIndicator());

  // 11. 引用消息解析（记录 + 解析被引用原文）
  bot.use(quoteRef({
    maxSize: 500,
    preferMsgElements: true,
  }));

  // 12. 上下文组装（将 history + quote + sender 组成 envelope）
  bot.use(envelopeFormatter({
    historyLimit: config.historyLimit,
    includeQuote: true,
    includeSender: true,
  }));

  // ── 记忆召回注入：把相关长期记忆拼接到本轮用户内容前 ──
  if (memoryStore) {
    bot.use(async (mCtx: MiddlewareContext, next: () => Promise<void>) => {
      const msg = mCtx.message as unknown as {
        kind?: string;
        senderId: string;
        groupOpenid?: string;
        content?: string;
      };
      const scope: 'c2c' | 'group' = msg.kind === 'group' ? 'group' : 'c2c';
      const peerId = scope === 'group' ? (msg.groupOpenid ?? msg.senderId) : msg.senderId;
      const peerKey = `official:${scope}:${peerId}`;
      const query = msg.content ?? '';
      // 来源补存：原始消息先无损留存
      memoryStore.recordSource(peerKey, query);
      const prefix = memoryStore.buildPromptBlock(
        peerKey,
        query,
        config.memory.recallLimit,
        config.memory.maxChars,
      );
      if (prefix) msg.content = prefix + query;
      await next();
    });
  }

  // ══════════════════════════════════════════════════════════════
  // 最终处理：经过中间件链后的消息交给 dsh agent
  // ══════════════════════════════════════════════════════════════

  bot.on('message', async (mCtx: MiddlewareContext) => {
    const msg = mCtx.message;
    if (config.debug) {
      console.log(`[im-qqbot] [pipeline] access passed; forwarding message to DSH`);
    }
    await handleInbound(msg, manager, config, logger, mCtx.state);
  });

  // ── 出站 ──
  const outboundHandler = createOutboundHandler(manager, bot, config, logger);
  (ctx as unknown as { on(event: string, handler: (...args: unknown[]) => void): void })
    .on('session/event', outboundHandler as (...args: unknown[]) => void);

  // ── 官方通道情绪语音：助手完整回复后合成并发送语音 ──
  if (config.voice.enabled && config.voice.provider !== 'off') {
    const officialVoiceHandler = (
      session: { header: { id: string } },
      event: { type: string; data: Record<string, unknown> },
    ): void => {
      if (event.type !== 'assistant/message') return;
      const blocks = (event.data as { message?: { content?: Array<{ type: string; text?: string }> } })
        .message?.content;
      if (!Array.isArray(blocks)) return;
      const text = blocks
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text as string)
        .join('\n')
        .trim();
      if (!text) return;
      const record = manager.findBySessionId(session.header.id);
      if (!record) return;
      const emotion = detectEmotion(text);
      void synthesize(config.voice, text, emotion)
        .then((res) => bot.sendVoice(record.replyTarget, { localPath: res.file }))
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          logger.warn(`[voice] 官方通道语音发送失败（已保留文字回复）: ${detail}`);
        });
    };
    (ctx as unknown as { on(event: string, handler: (...args: unknown[]) => void): void })
      .on('session/event', officialVoiceHandler as unknown as (...args: unknown[]) => void);
  }

  // ── 官方通道：轮次结束（压缩前）记忆补存 ──
  if (memoryStore) {
    const memoryTurnHandler = (
      session: { header: { id: string } },
      event: { type: string; data: Record<string, unknown> },
    ): void => {
      if (event.type !== 'turn/end') return;
      const record = manager.findBySessionId(session.header.id);
      if (!record) return;
      const peerKey = `official:${record.scope}:${record.peerId}`;
      void memoryStore
        .extractFromSources(peerKey, keywordExtractor)
        .then((count) => {
          if (count > 0) logger.info(`[memory] 本轮结束补存 ${count} 条事实 (${peerKey})`);
        })
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          logger.warn(`[memory] 补存失败: ${detail}`);
        });
    };
    (ctx as unknown as { on(event: string, handler: (...args: unknown[]) => void): void })
      .on('session/event', memoryTurnHandler as unknown as (...args: unknown[]) => void);
  }

  if (config.enableApprovals) {
    (ctx as unknown as {
      on(
        event: 'approval/request',
        handler: (req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>,
      ): void;
    }).on('approval/request', (req, next) => approvalController.request(req, next));
  }

  bot.on('error', (err: unknown) => {
    logger.error(`bot error: ${err instanceof Error ? err.message : String(err)}`);
  });

  bot.on('ready', () => {
    console.log(`[im-qqbot] Bot ready! appId=${config.appId}`);
  });

  // ── 生命周期 ──
  (ctx as unknown as { effect(fn: () => (() => Promise<void>) | void, name?: string): void })
    .effect(() => {
      logger.info(`Starting bot (appId=${config.appId})`);
      bot.start().catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        logger.error(`Bot start failed: ${detail}`);
        console.error(`[im-qqbot] Bot start failed: ${detail}`);
      });

      return async () => {
        logger.info('Shutting down');
        approvalController.dispose();
        await manager.disposeAll();
        bot.stop();
      };
    }, 'im-qqbot.lifecycle');
}
