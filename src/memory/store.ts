/**
 * MemoryStore — 记忆宫殿本地存储与检索
 *
 * 设计对齐参考项目 dsh-dafeiyu-dot 的记忆思路（确定性本地检索，非向量库）：
 * - 长期事实存为 Markdown（人可读）+ 同构 JSON（程序用索引）
 * - 按会话（peer）隔离，文件名为「安全短名 + 内容哈希」，避免路径注入
 * - 遗忘用墓碑（forgotten 标记），不物理删除
 * - 回复前按关键词/别名召回有限条事实注入 prompt
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { MemoryFact, MemoryFileData } from './types.js';
import type { MemoryExtractor } from './extract.js';

/** 来源队列上限：超过阈值时仅保留最近若干行，防止无上限增长 */
const MAX_SOURCES_LINES = 500;
const MAX_SOURCES_BYTES = 256 * 1024;

/** 默认记忆根目录：$DSH_HOME/dsh-qqbot-bridge/memory-palace */
export function defaultMemoryRoot(): string {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'dsh-qqbot-bridge', 'memory-palace');
}

/** 会话 key → 安全文件名（短名 + 哈希，防路径穿越） */
export function peerFileKey(peerKey: string): string {
  const hash = createHash('sha256').update(peerKey).digest('hex').slice(0, 8);
  const safe = peerKey.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
  return `${safe}-${hash}`;
}

/**
 * 确定性关键词检索（纯函数，便于单测）
 * - 忽略已遗忘事实
 * - 空查询返回最近 limit 条
 * - 按命中数 + 新鲜度排序
 */
export function searchFacts(facts: MemoryFact[], query: string, limit: number): MemoryFact[] {
  const active = facts.filter((f) => !f.forgotten);
  if (limit <= 0) return [];
  const q = query.trim().toLowerCase();
  if (!q) return active.slice(-limit).reverse();

  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return active.slice(-limit).reverse();

  const scored: Array<{ fact: MemoryFact; score: number }> = [];
  for (const fact of active) {
    const hay = fact.text.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (hay.includes(token)) score += 3;
    }
    if (score > 0) scored.push({ fact, score });
  }

  scored.sort((a, b) => b.score - a.score || b.fact.createdAt - a.fact.createdAt);
  return scored.slice(0, limit).map((s) => s.fact);
}

export class MemoryStore {
  private readonly cache = new Map<string, MemoryFileData>();

  constructor(private readonly rootDir: string = defaultMemoryRoot()) {}

  get root(): string {
    return this.rootDir;
  }

  private jsonPath(peerKey: string): string {
    return join(this.rootDir, `${peerFileKey(peerKey)}.json`);
  }

  private mdPath(peerKey: string): string {
    return join(this.rootDir, `${peerFileKey(peerKey)}.md`);
  }

  private sourcesPath(peerKey: string): string {
    return join(this.rootDir, `${peerFileKey(peerKey)}.sources.jsonl`);
  }

  /**
   * 来源补存：把原始用户消息追加到会话的来源队列（jsonl）。
   * 在「回复前 / 任何可能丢失上下文的环节之前」持续记录来源，
   * 之后可由事实整理（提取）从来源中提炼长期事实。属于无损来源留存。
   */
  recordSource(peerKey: string, text: string, source = 'user'): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    mkdirSync(this.rootDir, { recursive: true });
    appendFileSync(
      this.sourcesPath(peerKey),
      `${JSON.stringify({ at: Date.now(), source, text: trimmed })}\n`,
      'utf8',
    );
    // 防止来源队列无上限增长（例如 flush 从未运行）：超过字节阈值时仅保留最近 MAX_SOURCES_LINES 行
    try {
      const p = this.sourcesPath(peerKey);
      if (statSync(p).size > MAX_SOURCES_BYTES) {
        const lines = readFileSync(p, 'utf8').split('\n').filter((line) => line.trim());
        const kept = lines.slice(-MAX_SOURCES_LINES);
        writeFileSync(p, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
      }
    } catch {
      /* ignore */
    }
  }

  /** 读取来源队列（用于整理/测试） */
  readSources(peerKey: string): Array<{ at: number; source: string; text: string }> {
    try {
      const path = this.sourcesPath(peerKey);
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as { at: number; source: string; text: string });
    } catch {
      return [];
    }
  }

  /** 清空来源队列（抽取完成后调用） */
  clearSources(peerKey: string): void {
    try {
      mkdirSync(this.rootDir, { recursive: true });
      writeFileSync(this.sourcesPath(peerKey), '', 'utf8');
    } catch {
      /* ignore */
    }
  }

  /**
   * 从来源队列抽取长期事实（轮次结束/压缩前调用）。
   * 去重后写入记忆宫殿，并清空已处理的来源。返回新增条数。
   */
  async extractFromSources(peerKey: string, extractor: MemoryExtractor): Promise<number> {
    const srcPath = this.sourcesPath(peerKey);
    if (!existsSync(srcPath)) return 0;

    // 快照式处理：先把来源队列原子重命名为 .processing 文件，再处理该快照。
    // 抽取期间新到的消息会重新写入原路径，不会被本轮的清理覆盖（避免静默丢失）。
    const procPath = `${srcPath}.processing-${randomUUID()}`;
    try {
      renameSync(srcPath, procPath);
    } catch {
      return 0; // 被并发处理或不复存在
    }

    let sources: Array<{ at: number; source: string; text: string }> = [];
    try {
      sources = readFileSync(procPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as { at: number; source: string; text: string });
    } catch {
      sources = [];
    }

    const existing = new Set(this.list(peerKey).map((f) => f.text));
    let added = 0;
    try {
      for (const source of sources) {
        const facts = await extractor.extract(source.text);
        for (const raw of facts) {
          const text = raw.trim();
          if (!text || existing.has(text)) continue;
          this.add(peerKey, text, 'auto');
          existing.add(text);
          added += 1;
        }
      }
    } catch (err) {
      // 抽取失败：把未处理快照追加回原队列（去重会避免重复），避免来源丢失
      try {
        appendFileSync(srcPath, readFileSync(procPath, 'utf8'), 'utf8');
      } catch {
        /* ignore */
      }
      try {
        rmSync(procPath, { force: true });
      } catch {
        /* ignore */
      }
      throw err;
    }

    try {
      rmSync(procPath, { force: true });
    } catch {
      /* ignore */
    }
    return added;
  }

  private load(peerKey: string): MemoryFileData {
    const cached = this.cache.get(peerKey);
    if (cached) return cached;

    let data: MemoryFileData = { version: 1, facts: [] };
    try {
      const path = this.jsonPath(peerKey);
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MemoryFileData>;
        if (parsed && Array.isArray(parsed.facts)) {
          data = { version: 1, facts: parsed.facts };
        }
      }
    } catch {
      // 文件损坏：先备份再重置，避免下一次 persist 静默覆盖掉仍可恢复的数据
      try {
        const path = this.jsonPath(peerKey);
        if (existsSync(path)) renameSync(path, `${path}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      data = { version: 1, facts: [] };
    }
    this.cache.set(peerKey, data);
    return data;
  }

  private persist(peerKey: string, data: MemoryFileData): void {
    mkdirSync(this.rootDir, { recursive: true });
    // 原子写：先写临时文件再 rename，避免进程中断导致 JSON 损坏
    atomicWrite(this.jsonPath(peerKey), JSON.stringify(data, null, 2));
    atomicWrite(this.mdPath(peerKey), renderMarkdown(peerKey, data));
    this.cache.set(peerKey, data);
  }

  /** 追加一条长期事实 */
  add(peerKey: string, text: string, source: MemoryFact['source'] = 'command', tags?: string[]): MemoryFact {
    const data = this.load(peerKey);
    const fact: MemoryFact = {
      id: randomUUID(),
      text: text.trim(),
      createdAt: Date.now(),
      source,
      ...(tags && tags.length > 0 ? { tags } : {}),
    };
    data.facts.push(fact);
    this.persist(peerKey, data);
    return fact;
  }

  /** 列出事实（默认不含已遗忘） */
  list(peerKey: string, includeForgotten = false): MemoryFact[] {
    const data = this.load(peerKey);
    return includeForgotten ? [...data.facts] : data.facts.filter((f) => !f.forgotten);
  }

  /** 遗忘（墓碑）：按 id 前缀匹配第一条未遗忘事实 */
  forget(peerKey: string, idPrefix: string): MemoryFact | null {
    const data = this.load(peerKey);
    const fact = data.facts.find((f) => !f.forgotten && f.id.startsWith(idPrefix));
    if (!fact) return null;
    fact.forgotten = true;
    fact.forgottenAt = Date.now();
    fact.updatedAt = Date.now();
    this.persist(peerKey, data);
    return fact;
  }

  /** 检索相关事实 */
  search(peerKey: string, query: string, limit = 6): MemoryFact[] {
    return searchFacts(this.load(peerKey).facts, query, limit);
  }

  /** 生成注入 prompt 的记忆块；无命中返回空串 */
  buildPromptBlock(peerKey: string, query: string, limit = 6, maxChars = 3600): string {
    const facts = this.search(peerKey, query, limit);
    if (facts.length === 0) return '';

    const lines: string[] = [];
    let total = 0;
    for (const fact of facts) {
      const line = `- ${fact.text}`;
      if (total + line.length > maxChars) break;
      lines.push(line);
      total += line.length + 1;
    }
    if (lines.length === 0) return '';
    return `[长期记忆（仅供参考，可能与当前情况不同）]\n${lines.join('\n')}\n[长期记忆结束]\n\n`;
  }
}

function renderMarkdown(peerKey: string, data: MemoryFileData): string {  const lines: string[] = [`# 记忆宫殿 · ${peerKey}`, ''];
  for (const fact of data.facts) {
    const flag = fact.forgotten ? ' _(已遗忘)_' : '';
    lines.push(`- [${fact.id.slice(0, 8)}] ${fact.text}${flag}`);
  }
  if (data.facts.length === 0) lines.push('_（暂无记忆）_');
  lines.push('');
  return lines.join('\n');
}

/** 原子写文件：先写临时文件再 rename，避免半截写入导致的损坏 */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}
