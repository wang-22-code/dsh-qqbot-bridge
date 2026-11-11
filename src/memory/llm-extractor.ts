/**
 * LLM 语义抽取器 —— 用 DSH 的对话模型把"来源原话"提炼成长期事实。
 *
 * 通过 `ctx.llm.stream({ provider, model, messages, signal })` 调用，产出
 * `text-delta` 分片；解析成每行一条的事实。失败由上层用"降级到关键词抽取器"
 * 兜底（见 createResilientExtractor）。
 */
import type { MemoryExtractor } from './extract.js';

export interface LlmStreamChunkLike {
  type: string;
  text?: string;
  reason?: { kind?: string };
}

export interface LlmServiceLike {
  stream(options: {
    provider: string;
    model: string;
    messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }> }>;
    signal?: AbortSignal;
    maxTokens?: number;
    temperature?: number;
  }): AsyncIterable<LlmStreamChunkLike>;
}

const PROMPT_PREFIX = [
  '你是记忆提取器。下面是一条用户消息。请提取其中值得长期记住的事实',
  '（偏好、称呼、住址、生日、重要约定、明确要求记住的内容等）。',
  '要求：每条一行；只输出事实本身，不要编号、不要解释；没有就输出 NONE；最多 6 条。',
  '',
  '用户消息：',
].join('\n');

/** 解析 LLM 输出为事实列表（纯函数，便于单测） */
export function parseExtractedFacts(raw: string): string[] {
  const out: string[] = [];
  for (const line of (raw ?? '').replace(/\r\n/g, '\n').split('\n')) {
    let text = line.trim();
    if (!text) continue;
    text = text.replace(/^[-*•]\s+/, '').replace(/^\d+[.)、]\s*/, '').trim();
    if (!text || /^none$/i.test(text)) continue;
    if (text.length > 200) text = text.slice(0, 200);
    out.push(text);
  }
  return [...new Set(out)];
}

export interface LlmExtractorOptions {
  llm: LlmServiceLike;
  provider: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
}

/** 创建基于 DSH 对话模型的语义抽取器 */
export function createLlmExtractor(opts: LlmExtractorOptions): MemoryExtractor {
  return {
    name: `llm:${opts.provider}/${opts.model}`,
    async extract(text: string): Promise<string[]> {
      const trimmed = (text ?? '').trim();
      if (!trimmed) return [];

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
      const parts: string[] = [];
      try {
        for await (const chunk of opts.llm.stream({
          provider: opts.provider,
          model: opts.model,
          messages: [
            { role: 'user', content: [{ type: 'text', text: `${PROMPT_PREFIX}${trimmed}` }] },
          ],
          signal: controller.signal,
          maxTokens: opts.maxTokens ?? 400,
          temperature: 0,
        })) {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            parts.push(chunk.text);
          } else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
            throw new Error('LLM 抽取结束于错误状态');
          }
        }
      } finally {
        clearTimeout(timer);
      }
      return parseExtractedFacts(parts.join(''));
    },
  };
}
