/**
 * OneBot v11 通道（NapCat 等个人号网关）
 */
export { OneBotClient, type OneBotClientOptions } from './client.js';
export { OneBotApi, type OneBotLoginInfo } from './api.js';
export { OneBotSender } from './sender.js';
export {
  fetchNapCatQrcode,
  parseNapCatQrPayload,
  type NapCatQrInfo,
  type NapCatQrFetchOptions,
  type NapCatQrFetchResult,
} from './napcat-login.js';
export {
  parseSegments,
  extractText,
  isMentioned,
  shouldAccept,
  normalizeTarget,
  buildInboundText,
  type OneBotSegment,
  type OneBotMessageEvent,
} from './inbound.js';
