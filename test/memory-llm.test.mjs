import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExtractedFacts, createLlmExtractor, createResilientExtractor, keywordExtractor } from '../dist/memory/index.js';

test('parseExtractedFacts strips bullets/numbers, drops NONE, dedupes', () => {
  const raw = '- 喜欢喝茶\n2. 叫 Alice\nNONE\n• 喜欢喝茶\n\n';
  const facts = parseExtractedFacts(raw);
  assert.deepEqual(facts, ['喜欢喝茶', '叫 Alice']);
});

async function* gen(chunks) {
  for (const c of chunks) yield c;
}

test('createLlmExtractor streams text-delta and parses facts', async () => {
  const fakeLlm = {
    stream() {
      return gen([
        { type: 'text-delta', text: '- 主人喜欢喝美式咖啡\n' },
        { type: 'text-delta', text: '- 主人住在杭州\n' },
        { type: 'finish', reason: { kind: 'stop' } },
      ]);
    },
  };
  const ex = createLlmExtractor({ llm: fakeLlm, provider: 'p', model: 'm' });
  const facts = await ex.extract('我喜欢喝美式咖啡，我住在杭州');
  assert.deepEqual(facts, ['主人喜欢喝美式咖啡', '主人住在杭州']);
});

test('createLlmExtractor throws on error finish', async () => {
  const fakeLlm = { stream: () => gen([{ type: 'finish', reason: { kind: 'error' } }]) };
  const ex = createLlmExtractor({ llm: fakeLlm, provider: 'p', model: 'm' });
  await assert.rejects(() => ex.extract('x'), /error|错误/);
});

test('createResilientExtractor falls back to keyword on primary failure', async () => {
  const broken = { name: 'broken', extract: async () => { throw new Error('llm down'); } };
  let seen = '';
  const resilient = createResilientExtractor(broken, keywordExtractor, (m) => { seen = m; });
  const facts = await resilient.extract('记住：主人对花生过敏');
  assert.ok(facts.some((f) => /花生过敏/.test(f)));
  assert.match(seen, /llm down/);
});
