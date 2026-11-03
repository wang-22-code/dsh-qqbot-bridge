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

export interface OneBotConfig {
  /** OneBot v11 正向 WebSocket 地址（NapCat 等） */
  wsUrl: string;
  /** 访问令牌（OneBot access_token，可留空） */
  accessToken: string;
  /** 机器人自身 QQ 号（用于 @ 检测；留空则连接后自动获取） */
  selfId: string;
  /** 断线重连最大间隔(ms) */
  reconnectMaxMs: number;
  /** NapCat WebUI 地址（可选，用于查询登录二维码） */
  webuiUrl: string;
  /** NapCat WebUI Token（可选） */
  webuiToken: string;
}

export interface MemoryConfig {
  /** 是否启用记忆宫殿 */
  enabled: boolean;
  /** 记忆根目录（留空则用 $DSH_HOME/dsh-qqbot-bridge/memory-palace） */
  dir: string;
  /** 回复前最多召回的事实条数 */
  recallLimit: number;
  /** 注入 prompt 的记忆最大字符数 */
  maxChars: number;
}

export interface VoiceConfig {
  /** 是否启用语音回复 */
  enabled: boolean;
  /** 语音服务类型 */
  provider: 'off' | 'breezeblue' | 'openai' | 'local';
  /** 是否启用情绪指令 */
  emotional: boolean;
  /** API Key（BreezeBlue 与 OpenAI 兼容用） */
  apiKey: string;
  /** BreezeBlue 服务地址 */
  breezeUrl: string;
  /** BreezeBlue 模型 */
  breezeModel: string;
  /** BreezeBlue 音色 id */
  breezeVoice: string;
  /** 情绪强度 guidance_scale */
  guidanceScale: number;
  /** OpenAI 兼容地址 */
  openaiUrl: string;
  /** OpenAI 兼容模型 */
  openaiModel: string;
  /** OpenAI 兼容音色 */
  openaiVoice: string;
  /** 本地 audiocpp 地址 */
  localUrl: string;
  /** 本地模型名 */
  localModel: string;
  /** 本地音色 */
  localVoice: string;
  /** 单次合成最大字符数 */
  maxChars: number;
}

export interface ImQQBotConfig {
  /** 通道类型：official=腾讯官方 QQ 机器人；onebot=NapCat/OneBot v11 个人号 */
  channel: 'official' | 'onebot';
  /** OneBot 通道配置 */
  onebot: OneBotConfig;
  /** 记忆宫殿配置 */
  memory: MemoryConfig;
  /** 情绪语音配置 */
  voice: VoiceConfig;
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
  channel: Schema.union(['official', 'onebot']).default('official').description('通道类型：official=腾讯官方QQ机器人；onebot=NapCat/OneBot v11个人号'),
  onebot: Schema.object({
    wsUrl: Schema.string().default('ws://127.0.0.1:3001').description('OneBot v11 正向 WebSocket 地址'),
    accessToken: Schema.string().default('').description('OneBot access_token（可留空）'),
    selfId: Schema.string().default('').description('机器人自身 QQ 号（留空则自动获取）'),
    reconnectMaxMs: Schema.number().default(30000).description('断线重连最大间隔(ms)'),
    webuiUrl: Schema.string().default('').description('NapCat WebUI 地址（用于查询登录二维码）'),
    webuiToken: Schema.string().default('').description('NapCat WebUI Token'),
  }).default({
    wsUrl: 'ws://127.0.0.1:3001',
    accessToken: '',
    selfId: '',
    reconnectMaxMs: 30000,
    webuiUrl: '',
    webuiToken: '',
  }).description('OneBot 通道配置'),
  memory: Schema.object({
    enabled: Schema.boolean().default(true).description('是否启用记忆宫殿'),
    dir: Schema.string().default('').description('记忆根目录（留空使用默认）'),
    recallLimit: Schema.number().default(6).description('回复前最多召回事实条数'),
    maxChars: Schema.number().default(3600).description('注入 prompt 的记忆最大字符数'),
  }).default({
    enabled: true,
    dir: '',
    recallLimit: 6,
    maxChars: 3600,
  }).description('记忆宫殿配置'),
  voice: Schema.object({
    enabled: Schema.boolean().default(false).description('是否启用语音回复'),
    provider: Schema.union(['off', 'breezeblue', 'openai', 'local']).default('off').description('语音服务类型'),
    emotional: Schema.boolean().default(true).description('是否启用情绪指令'),
    apiKey: Schema.string().default('').description('API Key'),
    breezeUrl: Schema.string().default('https://api.breeze.blue/v1').description('BreezeBlue 服务地址'),
    breezeModel: Schema.string().default('breeze-tts-2').description('BreezeBlue 模型'),
    breezeVoice: Schema.string().default('').description('BreezeBlue 音色 id'),
    guidanceScale: Schema.number().default(1.0).description('情绪强度 guidance_scale'),
    openaiUrl: Schema.string().default('https://api.openai.com/v1').description('OpenAI 兼容地址'),
    openaiModel: Schema.string().default('tts-1').description('OpenAI 兼容模型'),
    openaiVoice: Schema.string().default('alloy').description('OpenAI 兼容音色'),
    localUrl: Schema.string().default('http://127.0.0.1:3900/v1').description('本地 audiocpp 地址'),
    localModel: Schema.string().default('audiocpp').description('本地模型名'),
    localVoice: Schema.string().default('').description('本地音色'),
    maxChars: Schema.number().default(1000).description('单次合成最大字符数'),
  }).default({
    enabled: false,
    provider: 'off',
    emotional: true,
    apiKey: '',
    breezeUrl: 'https://api.breeze.blue/v1',
    breezeModel: 'breeze-tts-2',
    breezeVoice: '',
    guidanceScale: 1.0,
    openaiUrl: 'https://api.openai.com/v1',
    openaiModel: 'tts-1',
    openaiVoice: 'alloy',
    localUrl: 'http://127.0.0.1:3900/v1',
    localModel: 'audiocpp',
    localVoice: '',
    maxChars: 1000,
  }).description('情绪语音配置'),
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
