/**
 * 记忆宫殿类型定义
 */

/** 一条长期事实 */
export interface MemoryFact {
  /** 唯一 id（UUID） */
  id: string;
  /** 事实正文 */
  text: string;
  /** 创建时间（epoch ms） */
  createdAt: number;
  /** 最近更新时间（epoch ms） */
  updatedAt?: number;
  /** 来源：用户显式命令 / 自动整理 / 用户对话 */
  source: 'user' | 'command' | 'auto';
  /** 可选标签 */
  tags?: string[];
  /** 是否已遗忘（墓碑保护，不物理删除） */
  forgotten?: boolean;
  /** 遗忘时间 */
  forgottenAt?: number;
}

/** 单个会话（peer）的记忆文件结构 */
export interface MemoryFileData {
  version: 1;
  facts: MemoryFact[];
}
