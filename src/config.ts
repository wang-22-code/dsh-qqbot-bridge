/**
 * dsh-im-qqbot 插件配置 Schema
 */
import Schema from '@deepseek-ai/schemastery';

export interface AccessControlConfig {
  /** C2C 访问模式 */
  c2cMode: 'open' | 'allowlist' | 'disabled';
  /** C2C 白名单（user openid） */
  c2cAllow: string[];
  /** 群聊访问模式 */
  groupMode: 'open' | 'allowlist' | 'disabled';
  /** 群聊白名单（group openid） */
  groupAllow: string[];
}

export interface ImQQBotConfig {
  /** QQ Bot AppID */
  appId: string;
  /** QQ Bot AppSecret */
  appSecret: string;
  /** dsh LLM 提供商名称 */
  provider?: string;
  /** 模型名称 */
  model?: string;
  /** Agent preset id */
  preset?: string;
  /** Agent 工作目录 */
  cwd: string;
  /** 是否启用群消息 @mention 门控 */
  requireMention: boolean;
  /** 群聊额外 system prompt */
  groupPrompt?: string;
  /** 私聊额外 system prompt */
  directPrompt?: string;
  /** 单条消息最大长度（QQ 限制约 5000 字符） */
  textChunkLimit: number;
  /** 流式增量下发间隔(ms)；0 = 等整条消息生成后一次性发送（旧行为） */
  streamFlushIntervalMs: number;
  /** 单段内容发送失败的最大重试次数 */
  sendMaxRetries: number;
  /** 发送重试指数退避基数(ms) */
  sendRetryBaseMs: number;
  /** 每会话最大闲置时长(ms)，超时自动回收 */
  sessionIdleTimeout: number;
  /** 并发队列最大长度 */
  maxQueue: number;
  /** 处理超时(ms)，超时中断当前 LLM 调用 */
  processingTimeoutMs: number;
  /** 群历史缓冲条数 */
  historyLimit: number;
  /** 访问控制 */
  access: AccessControlConfig;
  /** 显式允许开放访问（防止误配为 open） */
  acknowledgeOpenAccess: boolean;
  /** 是否允许将 Agent 工作目录设为文件系统根目录 */
  allowUnsafeCwd: boolean;
  /** 是否在日志中记录消息正文 */
  logMessageContent: boolean;
  /** 调试模式 */
  debug: boolean;
  /** 是否通过 QQ 处理 DSH 的一次性权限申请 */
  enableApprovals: boolean;
  /** QQ 权限申请等待时长(ms) */
  approvalTimeoutMs: number;
}

export const ConfigSchema: Schema<ImQQBotConfig> = Schema.object({
  appId: Schema.string().default('').description('QQ Bot AppID'),
  appSecret: Schema.string().default('').description('QQ Bot AppSecret'),
  provider: Schema.string().description('LLM provider name'),
  model: Schema.string().description('Model name'),
  preset: Schema.string().description('Agent preset id'),
  cwd: Schema.string().default('').description('Agent working directory（必须显式配置，安全版不接受文件系统根目录）'),
  requireMention: Schema.boolean().default(true).description('群聊是否需要@bot触发'),
  groupPrompt: Schema.string().description('群聊额外system prompt'),
  directPrompt: Schema.string().description('私聊额外system prompt'),
  textChunkLimit: Schema.number().default(4500).description('单条消息最大字符数'),
  streamFlushIntervalMs: Schema.number().default(2000).description('流式增量下发间隔(ms)，0=关闭流式（等整条消息）'),
  sendMaxRetries: Schema.number().default(2).description('发送失败最大重试次数'),
  sendRetryBaseMs: Schema.number().default(1000).description('发送重试退避基数(ms)'),
  sessionIdleTimeout: Schema.number().default(30 * 60 * 1000).description('会话闲置超时(ms)'),
  maxQueue: Schema.number().default(20).description('并发队列最大长度'),
  processingTimeoutMs: Schema.number().default(120000).description('处理超时(ms)'),
  historyLimit: Schema.number().default(10).description('群历史缓冲条数'),
  access: Schema.object({
    c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('allowlist').description('C2C访问模式'),
    c2cAllow: Schema.array(Schema.string()).default([]).description('C2C白名单'),
    groupMode: Schema.union(['open', 'allowlist', 'disabled']).default('disabled').description('群聊访问模式'),
    groupAllow: Schema.array(Schema.string()).default([]).description('群聊白名单'),
  }).default({
    c2cMode: 'allowlist',
    c2cAllow: [],
    groupMode: 'disabled',
    groupAllow: [],
  }).description('访问控制'),
  acknowledgeOpenAccess: Schema.boolean().default(false).description('显式确认开放访问风险'),
  allowUnsafeCwd: Schema.boolean().default(false).description('允许 Agent 使用文件系统根目录'),
  logMessageContent: Schema.boolean().default(false).description('在日志中记录消息正文（可能包含隐私）'),
  debug: Schema.boolean().default(false),
  enableApprovals: Schema.boolean().default(true).description('通过 QQ 接收并处理 DSH 一次性权限申请'),
  approvalTimeoutMs: Schema.number().default(120000).description('QQ 权限申请超时(ms)，超时自动拒绝'),
});
