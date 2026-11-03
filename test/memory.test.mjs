import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, searchFacts, peerFileKey, handleMemoryCommand, autoCapture, keywordExtractor } from '../dist/memory/index.js';

function newStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mem-'));
  return { store: new MemoryStore(dir), dir };
}

test('add and list facts', () => {
  const { store, dir } = newStore();
  try {
    const f1 = store.add('c2c:1', '主人喜欢喝美式咖啡', 'command');
    store.add('c2c:1', '主人住在杭州', 'command');
    const list = store.list('c2c:1');
    assert.equal(list.length, 2);
    assert.equal(list[0].id, f1.id);
    assert.equal(readdirSync(dir).some((n) => n.endsWith('.json')), true);
    assert.equal(readdirSync(dir).some((n) => n.endsWith('.md')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('searchFacts ranks keyword matches and ignores forgotten', () => {
  const facts = [
    { id: 'a', text: '喜欢美式咖啡', createdAt: 1, source: 'command' },
    { id: 'b', text: '喜欢爬山', createdAt: 2, source: 'command' },
    { id: 'c', text: '咖啡豆过敏', createdAt: 3, source: 'command', forgotten: true },
  ];
  const hit = searchFacts(facts, '咖啡', 6);
  assert.deepEqual(hit.map((f) => f.id), ['a']);
});

test('forget creates a tombstone and removes from active list', () => {
  const { store, dir } = newStore();
  try {
    const f = store.add('c2c:2', '临时事实', 'command');
    assert.equal(store.list('c2c:2').length, 1);
    const forgotten = store.forget('c2c:2', f.id.slice(0, 8));
    assert.equal(forgotten?.id, f.id);
    assert.equal(store.list('c2c:2').length, 0);
    assert.equal(store.list('c2c:2', true).length, 1);
    assert.equal(store.list('c2c:2', true)[0].forgotten, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory is isolated per peer key', () => {
  const { store, dir } = newStore();
  try {
    store.add('c2c:1', 'A 的秘密', 'command');
    store.add('group:9', 'B 的秘密', 'command');
    assert.equal(store.list('c2c:1').length, 1);
    assert.equal(store.list('group:9').length, 1);
    assert.notEqual(peerFileKey('c2c:1'), peerFileKey('group:9'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildPromptBlock wraps only matching facts and respects maxChars', () => {
  const { store, dir } = newStore();
  try {
    store.add('c2c:3', '主人叫 Alice', 'command');
    store.add('c2c:3', '主人喜欢猫', 'command');
    const block = store.buildPromptBlock('c2c:3', '主人', 6, 3600);
    assert.match(block, /长期记忆/);
    assert.match(block, /喜欢猫/);
    assert.equal(block.includes('喜欢猫') && block.includes('叫 Alice'), true);

    const tiny = store.buildPromptBlock('c2c:3', '主人', 6, 5);
    assert.equal(tiny, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handleMemoryCommand parses add/list/search/forget', () => {  const { store, dir } = newStore();
  try {
    assert.equal(handleMemoryCommand(store, 'c2c:4', 'hello').handled, false);

    const add = handleMemoryCommand(store, 'c2c:4', '/memory add 记住我爱吃面');
    assert.equal(add.handled, true);
    assert.match(add.reply, /已记住/);

    const list = handleMemoryCommand(store, 'c2c:4', '/memory list');
    assert.match(list.reply, /爱吃面/);

    const search = handleMemoryCommand(store, 'c2c:4', '/memory search 面');
    assert.match(search.reply, /爱吃面/);

    const id = store.list('c2c:4')[0].id.slice(0, 8);
    const forget = handleMemoryCommand(store, 'c2c:4', `/memory forget ${id}`);
    assert.match(forget.reply, /已遗忘/);
    assert.equal(store.list('c2c:4').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('autoCapture saves "记住/记得" phrases automatically', () => {
  const { store, dir } = newStore();
  try {
    const f = autoCapture(store, 'c2c:5', '记住：主人对花生过敏');
    assert.ok(f);
    assert.equal(store.list('c2c:5').length, 1);
    assert.match(store.list('c2c:5')[0].text, /花生过敏/);

    assert.equal(autoCapture(store, 'c2c:5', '今天天气不错'), null);
    assert.equal(store.list('c2c:5').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordSource appends raw sources to a jsonl queue', () => {
  const { store, dir } = newStore();
  try {
    store.recordSource('c2c:6', '第一条原话');
    store.recordSource('c2c:6', '第二条原话');
    store.recordSource('c2c:6', '   ');
    const src = store.readSources('c2c:6');
    assert.equal(src.length, 2);
    assert.equal(src[0].text, '第一条原话');
    assert.equal(src[1].text, '第二条原话');
    assert.ok(src[0].at <= src[1].at);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keywordExtractor extracts structured facts', () => {
  const out = keywordExtractor.extract('记住：主人对花生过敏，我喜欢喝茶');
  assert.ok(out.some((x) => /花生过敏/.test(x)));
  assert.ok(out.some((x) => /喝茶|偏好/.test(x)));
  assert.deepEqual(keywordExtractor.extract('   '), []);
});

test('extractFromSources stores facts, dedupes, and clears the queue', async () => {
  const { store, dir } = newStore();
  try {
    store.recordSource('c2c:7', '记住：主人对花生过敏');
    store.recordSource('c2c:7', '记住：主人对花生过敏');
    const n1 = await store.extractFromSources('c2c:7', keywordExtractor);
    assert.ok(n1 >= 1);
    assert.ok(store.list('c2c:7').some((f) => /花生过敏/.test(f.text)));
    assert.equal(store.readSources('c2c:7').length, 0);

    // 重复来源不应产生重复事实
    store.recordSource('c2c:7', '记住：主人对花生过敏');
    const n2 = await store.extractFromSources('c2c:7', keywordExtractor);
    assert.equal(n2, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
