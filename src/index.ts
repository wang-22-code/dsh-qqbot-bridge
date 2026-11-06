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

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigSchema, type ImQQBotConfig } from './config.js';
import { SessionManager, type DshAgentRegistry } from './session/index.js';
import { bootstrapOneBot } from './channel/onebot.js';
import { handleInbound, createOutboundHandler } from './transport/index.js';
import { buildCommandList } from './commands/index.js';
import { resolveEnv, buildUserAgent } from './shared/index.js';
import { runQrSetup, persistCredentialsToDshEnv } from './setup.js';
import { validateSecurityConfig } from './security.js';
import { QqApprovalController, type ApprovalRequestLike, type ApprovalOutcome } from './approval.js';
import {
  MemoryStore,
  handleMemoryCommand,
  autoCapture,
  keywordExtractor,
  createResilientExtractor,
  createLlmExtractor,
  defaultMemoryRoot,
  type MemoryExtractor,
  type LlmServiceLike,
} from './memory/index.js';
import { synthesize, detectEmotion, type DshSpeechServiceLike } from './voice/index.js';
import type { Logger, ReplyTarget } from './types.js';
import { loadProjectEnv } from './shared/env-loader.js';

// ── Cordis 插件元数据 ──
export const name = 'im-qqbot';
export const inject = ['agents', 'approval'];
export const Config = ConfigSchema;

export type { ImQQBotConfig } from './config.js';

// ── 插件主体 ──
export async function apply(ctx: Context, config: ImQQBotConfig): Promise<void> {
  // 加载项目根目录 .env（以及包目录 .env），让「项目内 .env」成为最简配置入口。
  // 只弥补未设置的变量，不覆盖 $DSH_HOME/.env 已注入的值。
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const envLoad = loadProjectEnv(process.cwd(), packageRoot);
  applyEnvOverrides(config);
  if (config.debug) {
    try {
      const v = config.voice;
      console.log(
        `[im-qqbot] voice config: enabled=${String(v?.enabled)} provider=${String(v?.provider)} voiceId=${String(v?.breezeVoice)} hasKey=${Boolean(v && v.apiKey)}`,
      );
    } catch {
      /* ignore */
    }
  }

  const agents = (ctx as unknown as Record<string, unknown>).agents as DshAgentRegistry;
  const logger: Logger = ((ctx as unknown as Record<string, unknown>).logger as Logger) ?? console;
  const extractor = buildMemoryExtractor(ctx, config, logger);
  const speech = (() => {
    try {
      const c = ctx as unknown as { get?: (n: string) => unknown; speechToText?: unknown };
      const svc = typeof c.get === 'function' ? c.get('speechToText') : c.speechToText;
      return svc as DshSpeechServiceLike | undefined;
    } catch {
      return undefined;
    }
  })();

  console.log('[im-qqbot] apply() called');
  if (envLoad.keys.length > 0) {
    console.log(`[im-qqbot] 已加载 .env: ${envLoad.files.join(', ')} (keys: ${envLoad.keys.join(', ')})`);
  }

  // ── OneBot / NapCat 个人号通道 ──
  if (config.channel === 'onebot') {
    const resolvedOneBot: ImQQBotConfig = { ...config, appId: config.onebot.selfId || 'onebot' };
    await bootstrapOneBot(ctx, agents, resolvedOneBot, logger, extractor, speech);
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

    // 扫码用户自动加入本机私聊白名单，避免「绑定成功却被空白名单拦截」直到重启
    if (credentials.userOpenid) {
      process.env.QQBOT_C2C_ALLOW = credentials.userOpenid;
      if (config.access) config.access.c2cAllow = [credentials.userOpenid];
    }

    // 写入环境变量供热更新后的下次 apply 读取
    process.env.QQBOT_APPID = credentials.appId;
    process.env.QQBOT_SECRET = credentials.appSecret;

    appId = credentials.appId;
    appSecret = credentials.appSecret;
  }

  const resolvedConfig: ImQQBotConfig = { ...config, appId, appSecret };

  await bootstrap(ctx, agents, resolvedConfig, logger, extractor);
}

/**
 * 用进程环境变量补齐/覆盖运行配置，让「项目根 .env」成为最简配置入口。
 * 只覆盖“显式提供了环境变量”的项；未提供的保持 YAML/默认值。
 * YAML 里的 `!!js process.env.X` 可能在配置组装阶段早于 .env 加载而求值为空，
 * 因此这里在 apply 时以 env 为准补齐。
 */
function applyEnvOverrides(config: ImQQBotConfig): void {
  const env = process.env;

  // 通道
  if (env.IM_QQBOT_CHANNEL === 'official' || env.IM_QQBOT_CHANNEL === 'onebot') {
    config.channel = env.IM_QQBOT_CHANNEL;
  }

  // OneBot 配置
  if (config.onebot) {
    if (env.ONEBOT_WS_URL) config.onebot.wsUrl = env.ONEBOT_WS_URL;
    if (env.ONEBOT_ACCESS_TOKEN) config.onebot.accessToken = env.ONEBOT_ACCESS_TOKEN;
    if (env.ONEBOT_SELF_ID) config.onebot.selfId = env.ONEBOT_SELF_ID;
    if (env.ONEBOT_WEBUI_URL) config.onebot.webuiUrl = env.ONEBOT_WEBUI_URL;
    if (env.ONEBOT_WEBUI_TOKEN) config.onebot.webuiToken = env.ONEBOT_WEBUI_TOKEN;
  }

  // 记忆
  if (config.memory && env.MEMORY_ENABLED) {
    config.memory.enabled = /^(1|true|yes)$/i.test(env.MEMORY_ENABLED);
  }

  // 访问控制白名单也可由 .env 覆盖（否则 YAML 里的 !!js 早于 .env 加载会取空）
  if (config.access && env.QQBOT_C2C_ALLOW !== undefined) {
    config.access.c2cAllow = env.QQBOT_C2C_ALLOW.split(',').map((v) => v.trim()).filter(Boolean);
  }
  if (config.access && env.QQBOT_GROUP_ALLOW !== undefined) {
    config.access.groupAllow = env.QQBOT_GROUP_ALLOW.split(',').map((v) => v.trim()).filter(Boolean);
  }

  // 语音
  const voice = config.voice;
  if (voice) {
    if (env.VOICE_ENABLED) voice.enabled = /^(1|true|yes)$/i.test(env.VOICE_ENABLED);
    const vp = env.VOICE_PROVIDER;
    if (vp === 'off' || vp === 'breezeblue' || vp === 'openai' || vp === 'local') voice.provider = vp;
    if (!voice.apiKey && env.BREEZE_API_KEY) voice.apiKey = env.BREEZE_API_KEY;
    if (env.BREEZE_VOICE_ID) voice.breezeVoice = env.BREEZE_VOICE_ID;
    if (env.BREEZE_URL) voice.breezeUrl = env.BREEZE_URL;
    if (env.BREEZE_MODEL) voice.breezeModel = env.BREEZE_MODEL;
    if (env.VOICE_API_KEY) voice.apiKey = env.VOICE_API_KEY;
    if (env.VOICE_EMOTIONAL) voice.emotional = /^(1|true|yes)$/i.test(env.VOICE_EMOTIONAL);
  }

  // 语音输入转写（STT）
  if (config.stt) {
    if (env.STT_ENABLED) config.stt.enabled = /^(1|true|yes)$/i.test(env.STT_ENABLED);
    const sp = env.STT_PROVIDER;
    if (sp === 'off' || sp === 'dsh' || sp === 'openai') config.stt.provider = sp;
    if (env.STT_URL) config.stt.url = env.STT_URL;
    if (env.STT_MODEL) config.stt.model = env.STT_MODEL;
    if (env.STT_API_KEY) config.stt.apiKey = env.STT_API_KEY;
    if (env.STT_LANGUAGE) config.stt.language = env.STT_LANGUAGE;
    if (env.STT_FFMPEG_PATH) config.stt.ffmpegPath = env.STT_FFMPEG_PATH;
  }
}

/**
 * 选择记忆抽取器：优先用 DSH 对话模型做语义抽取，失败自动降级到关键词规则；
 * 若部署未提供 llm 服务则直接使用关键词规则。
 */
function buildMemoryExtractor(ctx: Context, config: ImQQBotConfig, logger: Logger): MemoryExtractor {
  try {
    const container = ctx as unknown as { get?: (name: string) => unknown; llm?: unknown };
    const llm = (typeof container.get === 'function' ? container.get('llm') : container.llm) as
      | LlmServiceLike
      | undefined;
    if (llm && typeof llm.stream === 'function') {
      const primary = createLlmExtractor({
        llm,
        provider: config.provider ?? 'deepseek-official',
        model: config.model ?? 'deepseek-v4-flash',
      });
      logger.info(`[memory] 使用 LLM 语义抽取器: ${primary.name}`);
      return createResilientExtractor(primary, keywordExtractor, (msg) =>
        logger.warn(`[memory] LLM 抽取失败，降级关键词: ${msg}`),
      );
    }
  } catch (err) {
    logger.warn(`[memory] 获取 llm 服务失败，使用关键词抽取: ${err instanceof Error ? err.message : String(err)}`);
  }
  logger.info('[memory] 使用关键词抽取器');
  return keywordExtractor;
}

async function bootstrap(
  ctx: Context,
  agents: DshAgentRegistry,
  config: ImQQBotConfig,
  logger: Logger,
  extractor: MemoryExtractor,
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
    // 频道(guild)消息默认拒绝，避免绕过 C2C/群白名单（官方通道默认 intents 含 guild）
    guild: { mode: 'disabled' },
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

  // ── 官方通道：轮次结束 & 压缩前(compaction/start) 记忆补存 ──
  if (memoryStore) {
    const memoryFlushHandler = (
      session: { header: { id: string } },
      event: { type: string; data: Record<string, unknown> },
    ): void => {
      if (event.type !== 'turn/end' && event.type !== 'compaction/start') return;
      const record = manager.findBySessionId(session.header.id);
      if (!record) return;
      const peerKey = `official:${record.scope}:${record.peerId}`;
      void memoryStore
        .extractFromSources(peerKey, extractor)
        .then((count) => {
          if (count > 0) {
            const phase = event.type === 'compaction/start' ? '压缩前' : '轮次结束';
            logger.info(`[memory] ${phase}补存 ${count} 条事实 (${peerKey})`);
          }
        })
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          logger.warn(`[memory] 补存失败: ${detail}`);
        });
    };
    (ctx as unknown as { on(event: string, handler: (...args: unknown[]) => void): void })
      .on('session/event', memoryFlushHandler as unknown as (...args: unknown[]) => void);
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
