/**
 * OneBot 通道引导：把 NapCat/OneBot v11 网关接入现有 SessionManager + 出站管线
 *
 * 复用：
 * - SessionManager（QQ peer → DSH Agent 映射、模型、preset）
 * - createOutboundHandler / OutboundBuffer（流式、切分、重试）
 * 只新增：OneBot WebSocket 客户端 + 收发适配。
 */
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

import type { ImQQBotConfig } from '../config.js';
import type { Logger } from '../types.js';
import { validateSecurityConfig } from '../security.js';
import { SessionManager, type DshAgentRegistry } from '../session/index.js';
import { createOutboundHandler } from '../transport/outbound.js';
import { MemoryStore, handleMemoryCommand, autoCapture, keywordExtractor, defaultMemoryRoot } from '../memory/index.js';
import { synthesize, detectEmotion } from '../voice/index.js';
import {
  OneBotClient,
  OneBotApi,
  OneBotSender,
  fetchNapCatQrcode,
  parseSegments,
  extractText,
  isMentioned,
  shouldAccept,
  normalizeTarget,
  buildInboundText,
  type OneBotMessageEvent,
} from '../transport/onebot/index.js';

interface SessionEventContext {
  on(event: string, handler: (...args: unknown[]) => void): void;
  effect(fn: () => (() => Promise<void> | void) | void, name?: string): void;
}

export async function bootstrapOneBot(
  ctx: Context,
  agents: DshAgentRegistry,
  config: ImQQBotConfig,
  logger: Logger,
): Promise<void> {
  const security = validateSecurityConfig(config);
  for (const warning of security.warnings) {
    logger.warn(`[security] ${warning}`);
    console.warn(`[im-qqbot] [security] ${warning}`);
  }
  if (security.errors.length > 0) {
    for (const error of security.errors) logger.error(`[security] ${error}`);
    logger.error('[security] 配置未通过安全检查，OneBot 通道未启动');
    return;
  }
  config.cwd = security.cwd;

  const manager = new SessionManager(ctx, agents, config, logger);
  const memoryStore = config.memory.enabled
    ? new MemoryStore(config.memory.dir || defaultMemoryRoot())
    : undefined;
  const client = new OneBotClient({
    url: config.onebot.wsUrl,
    accessToken: config.onebot.accessToken,
    reconnectMaxMs: config.onebot.reconnectMaxMs,
    logger,
  });
  const api = new OneBotApi(client);
  const sender = new OneBotSender(api);

  const onEvent = (event: OneBotMessageEvent): void => {
    void handleEvent(event).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error(`[onebot] 处理消息失败: ${detail}`);
    });
  };

  async function handleEvent(event: OneBotMessageEvent): Promise<void> {
    if (event.post_type !== 'message') return;

    const selfId = config.onebot.selfId;
    if (selfId && String(event.user_id) === selfId) return; // 忽略自己发出的消息

    const segments = parseSegments(event.message);
    const isGroup = event.message_type === 'group';

    if (!shouldAccept(config, event, isGroup)) {
      if (config.debug) {
        console.log(`[im-qqbot] [onebot] blocked by access policy (${isGroup ? 'group' : 'c2c'})`);
      }
      return;
    }

    if (isGroup && config.requireMention && !isMentioned(segments, selfId)) {
      return;
    }

    const target = normalizeTarget(event);
    const peerId = isGroup ? String(event.group_id) : String(event.user_id);
    const senderId = String(event.user_id ?? '');
    const peerKey = `${isGroup ? 'group' : 'c2c'}:${peerId}`;

    const rawText = extractText(segments);
    if (!rawText.trim()) return;

    // 记忆命令：直接处理并回复，不转发给 Agent
    if (memoryStore) {
      const cmd = handleMemoryCommand(memoryStore, peerKey, rawText);
      if (cmd.handled) {
        await sender.sendMarkdown(target, cmd.reply ?? '');
        return;
      }
      // 轻量自动补存（「记住…」）
      autoCapture(memoryStore, peerKey, rawText);
      // 来源补存：原始消息先无损留存，避免上下文丢失
      memoryStore.recordSource(peerKey, rawText);
    }

    let text = buildInboundText(event, segments, isGroup);
    if (!text.trim()) return;
    if (memoryStore) {
      const prefix = memoryStore.buildPromptBlock(
        peerKey,
        rawText,
        config.memory.recallLimit,
        config.memory.maxChars,
      );
      if (prefix) text = prefix + text;
    }

    const record = await manager.getOrCreate(
      isGroup ? 'group' : 'c2c',
      peerId,
      senderId,
      target,
    );

    const message = createUserMessage({
      content: [{ type: 'text' as const, text }],
      source: { kind: 'user' as const },
    });
    record.agent.followup(message);
    logger.info(`→ followup sent: channel=onebot scope=${isGroup ? 'group' : 'c2c'}`);
  }

  client.onEvent = (event: Record<string, unknown>) => onEvent(event as OneBotMessageEvent);

  const outboundHandler = createOutboundHandler(manager, sender, config, logger);
  (ctx as unknown as SessionEventContext).on(
    'session/event',
    outboundHandler as unknown as (...args: unknown[]) => void,
  );

  // ── 情绪语音：助手完整回复后合成语音并发送（失败保留文字回复） ──
  if (config.voice.enabled && config.voice.provider !== 'off') {
    const voiceHandler = (
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
        .then((res) => sender.sendVoice(record.replyTarget, res.file))
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          logger.warn(`[voice] 语音合成/发送失败（已保留文字回复）: ${detail}`);
        });
    };
    (ctx as unknown as SessionEventContext).on(
      'session/event',
      voiceHandler as unknown as (...args: unknown[]) => void,
    );
  }

  // ── 轮次结束（压缩前）记忆补存：把来源队列抽取为长期事实 ──
  if (memoryStore) {
    const memoryTurnHandler = (
      session: { header: { id: string } },
      event: { type: string; data: Record<string, unknown> },
    ): void => {
      if (event.type !== 'turn/end') return;
      const record = manager.findBySessionId(session.header.id);
      if (!record) return;
      const peerKey = `${record.scope}:${record.peerId}`;
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
    (ctx as unknown as SessionEventContext).on(
      'session/event',
      memoryTurnHandler as unknown as (...args: unknown[]) => void,
    );
  }

  (ctx as unknown as SessionEventContext).effect(() => {
    logger.info(`OneBot 通道启动，连接 ${config.onebot.wsUrl}`);
    // 若配置了 NapCat WebUI，主动拉取登录二维码，方便插件内扫码
    if (config.onebot.webuiUrl) {
      void fetchNapCatQrcode({
        webuiUrl: config.onebot.webuiUrl,
        token: config.onebot.webuiToken,
        logger,
      }).then((result) => {
        if (result.ok) {
          console.log(`[im-qqbot] [napcat] 登录二维码: ${result.file ?? result.qrUrl ?? '(见日志)'}`);
        } else {
          logger.warn(`[napcat] ${result.message}`);
        }
      });
    }
    client
      .start()
      .then(async () => {
        try {
          const info = await api.getLoginInfo();
          if (!config.onebot.selfId) config.onebot.selfId = String(info.user_id);
          console.log(`[im-qqbot] Bot ready! channel=onebot selfId=${info.user_id} nickname=${info.nickname}`);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          logger.warn(`[onebot] get_login_info 失败（不影响收发）: ${detail}`);
          console.log('[im-qqbot] Bot ready! channel=onebot');
        }
      })
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        logger.error(`[onebot] 连接失败: ${detail}`);
        console.error(`[im-qqbot] [onebot] 连接失败: ${detail}`);
      });

    return async () => {
      logger.info('OneBot 通道关闭');
      client.close();
      await manager.disposeAll();
    };
  }, 'im-qqbot.onebot.lifecycle');
}
