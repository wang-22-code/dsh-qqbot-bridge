/**
 * /memory 斜杠命令处理（纯逻辑，便于单测）
 *
 * 用法：
 *   /memory            列出记忆
 *   /memory list       列出记忆
 *   /memory add <文本> 记住一条
 *   /memory search <关键词>
 *   /memory forget <id前缀>
 */
import type { MemoryStore } from './store.js';
import type { MemoryFact } from './types.js';

export interface MemoryCommandResult {
  handled: boolean;
  reply?: string;
}

const PREFIX = /^\/memory(?:\s|$)/;
const AUTO_CAPTURE = /^(?:请)?(?:记住|记得|帮我记住)[：:，,\s]*([\s\S]+)$/;

/**
 * 轻量自动补存：用户说「记住…／记得…」时自动落库（无需 /memory 命令）。
 * 返回写入的事实；未命中返回 null。属于启发式，非语义抽取。
 */
export function autoCapture(store: MemoryStore, peerKey: string, text: string): MemoryFact | null {
  const match = AUTO_CAPTURE.exec(text.trim());
  if (!match) return null;
  const content = (match[1] ?? '').trim();
  if (!content) return null;
  return store.add(peerKey, content, 'auto');
}

export function handleMemoryCommand(
  store: MemoryStore,
  peerKey: string,
  text: string,
): MemoryCommandResult {
  const trimmed = text.trim();
  if (!PREFIX.test(trimmed)) return { handled: false };

  const rest = trimmed.replace(/^\/memory\s*/, '');
  const parts = rest.split(/\s+/).filter(Boolean);
  const sub = parts[0] ?? '';
  const arg = parts.slice(1).join(' ');

  if (sub === '' || sub === 'list') {
    return { handled: true, reply: formatList(store.list(peerKey)) };
  }
  if (sub === 'add') {
    if (!arg) return { handled: true, reply: '用法：/memory add <要记住的内容>' };
    const fact = store.add(peerKey, arg, 'command');
    return { handled: true, reply: `已记住（${fact.id.slice(0, 8)}）：${fact.text}` };
  }
  if (sub === 'search') {
    if (!arg) return { handled: true, reply: '用法：/memory search <关键词>' };
    return { handled: true, reply: formatList(store.search(peerKey, arg), '未找到相关记忆。') };
  }
  if (sub === 'forget') {
    if (!arg) return { handled: true, reply: '用法：/memory forget <id前缀>' };
    const fact = store.forget(peerKey, arg);
    return {
      handled: true,
      reply: fact ? `已遗忘（${fact.id.slice(0, 8)}）：${fact.text}` : '未找到该记忆。',
    };
  }
  return { handled: true, reply: '用法：/memory [list | add <文本> | search <关键词> | forget <id前缀>]' };
}

function formatList(facts: MemoryFact[], empty = '暂无记忆。'): string {
  if (facts.length === 0) return empty;
  const lines = facts.map((f) => `- [${f.id.slice(0, 8)}] ${f.text}`);
  return `共 ${facts.length} 条记忆：\n${lines.join('\n')}`;
}
