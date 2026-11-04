/**
 * 记忆抽取器（可插拔）
 *
 * `MemoryExtractor` 是抽象接口，便于把关键词启发式替换为「对话模型语义抽取」：
 * - 内置 keywordExtractor：结构化关键词规则（称呼/偏好/住址/生日/显式记住）
 * - 可传入任意实现（例如调用 DSH llm 做语义提炼），只需满足同一接口
 *
 * 抽取时机：在每轮结束/压缩前，对来源队列（*.sources.jsonl）执行抽取，
 * 提炼为长期事实后落入记忆宫殿。
 */
export interface MemoryExtractor {
  name: string;
  extract(text: string): string[] | Promise<string[]>;
}

const REMEMBER = /^(?:请)?(?:记住|记得|帮我记住)[：:，,\s]*([\s\S]+)$/;
const NAME = /(?:我叫|我的名字是|叫我)([^\s，。,.!?！？]{1,12})/;
const PREF = /(?:我)?(?:喜欢|爱|讨厌|不喜欢|爱吃|爱喝)([^，。,.!?！？]{1,20})/;
const HOME = /(?:我住在|我家在|我来自)([^，。,.!?！？]{1,20})/;
const BIRTH = /(?:我的)?生日(?:是|在)?([^\s，。,.!?！？]{1,20})/;

function dedupe(items: string[]): string[] {
  return [...new Set(items.map((s) => s.trim()).filter(Boolean))];
}

/** 关键词启发式抽取器 */
export const keywordExtractor: MemoryExtractor = {
  name: 'keyword',
  extract(text: string): string[] {
    const t = (text ?? '').trim();
    if (!t) return [];
    const out: string[] = [];

    const remember = REMEMBER.exec(t);
    if (remember && remember[1]) out.push(remember[1]);

    const pref = PREF.exec(t);
    if (pref) out.push(`偏好：${pref[0]}`);

    const name = NAME.exec(t);
    if (name && name[1]) out.push(`称呼：${name[1]}`);

    const home = HOME.exec(t);
    if (home && home[1]) out.push(`所在地：${home[1]}`);

    const birth = BIRTH.exec(t);
    if (birth && birth[1]) out.push(`生日：${birth[1]}`);

    return dedupe(out);
  },
};

/**
 * 组合抽取器：优先用 primary（如 LLM 语义抽取），失败时降级到 fallback
 * （如 keywordExtractor），保证抽取链路健壮、不会因模型异常而丢记忆。
 */
export function createResilientExtractor(
  primary: MemoryExtractor,
  fallback: MemoryExtractor,
  onError?: (message: string) => void,
): MemoryExtractor {
  return {
    name: `${primary.name}+fallback`,
    async extract(text: string): Promise<string[]> {
      try {
        return await primary.extract(text);
      } catch (err) {
        onError?.(err instanceof Error ? err.message : String(err));
        return await fallback.extract(text);
      }
    },
  };
}
