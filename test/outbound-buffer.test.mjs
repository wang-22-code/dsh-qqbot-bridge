import test from 'node:test';
import assert from 'node:assert/strict';
import { OutboundBuffer } from '../dist/transport/outbound-buffer.js';

/** 静默 logger */
const logger = { info() {}, warn() {}, error() {}, debug() {} };

function makeRecord() {
  return {
    replyTarget: { scope: 'c2c', targetId: 'user-1', msgId: 'm-1' },
  };
}

/** 记录每次调用的 mock sender */
function makeSender() {
  const calls = [];
  return {
    calls,
    async sendMarkdown(target, content) {
      calls.push({ target, content });
    },
  };
}

/** 按尝试次数抛错的 sender（attempts[i]=true 表示第 i 次尝试失败） */
function makeFlakySender(attempts, error = new Error('QQ API rate limit')) {
  const calls = [];
  return {
    calls,
    async sendMarkdown(target, content) {
      const failed = attempts[calls.length] ?? false;
      calls.push(content);
      if (failed) throw error;
    },
  };
}

test('happy path: append auto-schedules throttled incremental sends', async () => {
  const sender = makeSender();
  const buf = new OutboundBuffer(makeRecord(), sender, 100, logger, {
    flushIntervalMs: 50,
    maxRetries: 2,
    retryBaseMs: 10,
  });

  buf.append('hello ');
  buf.append('world');
  await buf.finalize();

  assert.equal(sender.calls.length, 1);
  assert.equal(sender.calls[0].content, 'hello world');
  assert.equal(buf.text, '');
});

test('happy path: multiple flushes each send their own segment', async () => {
  const sender = makeSender();
  const buf = new OutboundBuffer(makeRecord(), sender, 100, logger, {
    flushIntervalMs: 20,
    maxRetries: 2,
    retryBaseMs: 10,
  });

  buf.append('first');
  await buf.flush();
  buf.append('second');
  await buf.flush();

  assert.equal(sender.calls.length, 2);
  assert.equal(sender.calls[0].content, 'first');
  assert.equal(sender.calls[1].content, 'second');
  assert.equal(buf.text, '');
});

test('boundary: interval=0 disables auto-scheduling (legacy behavior)', async () => {
  const sender = makeSender();
  const buf = new OutboundBuffer(makeRecord(), sender, 100, logger);

  buf.append('text');
  // 不自动调度：无 timer 时 flush 需手动触发
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sender.calls.length, 0);

  await buf.flush();
  assert.equal(sender.calls.length, 1);
  assert.equal(buf.text, '');
});

test('retry: failed chunk is retried after backoff without dropping content', async () => {
  // 第 1 次尝试失败，重试成功
  const sender = makeFlakySender([true]);
  const buf = new OutboundBuffer(makeRecord(), sender, 100, logger, {
    flushIntervalMs: 0,
    maxRetries: 2,
    retryBaseMs: 10,
  });

  buf.append('important content');
  await buf.flush();

  // 两次尝试、最终一次成功送达
  assert.equal(sender.calls.length, 2);
  assert.deepEqual(sender.calls, ['important content', 'important content']);
  assert.equal(buf.text, '');
});

test('retry: prefix accounting — sent prefix is not resent, only remainder', async () => {
  // 尝试序列：chunk1 成功、chunk2 失败、重试发 chunk2 成功
  const outcomes = [false, true, false];
  const calls = [];
  const sender = {
    async sendMarkdown(target, content) {
      const fail = outcomes[calls.length] ?? false;
      calls.push(content);
      if (fail) throw new Error('rate limit');
    },
  };
  const buf = new OutboundBuffer(makeRecord(), sender, 11, logger, {
    flushIntervalMs: 0,
    maxRetries: 2,
    retryBaseMs: 5,
  });

  // 按行边界切分：两行各 10 字符，limit=11 → 两段
  buf.append('0123456789\nabcdefghij');
  await buf.flush();

  assert.deepEqual(calls, ['0123456789', 'abcdefghij', 'abcdefghij']);
  assert.equal(buf.text, '');
});

test('give up: retries exhausted triggers onGiveUp once and keeps remainder', async () => {
  const giveUps = [];
  const calls = [];
  const sender = {
    async sendMarkdown(target, content) {
      calls.push(content);
      throw new Error('persistently down');
    },
  };
  const buf = new OutboundBuffer(makeRecord(), sender, 100, logger, {
    flushIntervalMs: 0,
    maxRetries: 2,
    retryBaseMs: 1,
    onGiveUp: (err) => giveUps.push(err.message),
  });

  buf.append('must not vanish');
  await buf.flush();

  // 首次 + 2 次重试 = 3 次调用，onGiveUp 恰好一次
  assert.equal(calls.length, 3);
  assert.equal(giveUps.length, 1);
  assert.equal(giveUps[0], 'persistently down');
  assert.equal(buf.text, 'must not vanish');
});

test('fence boundary: unclosed code block stays in buffer until balanced', async () => {
  const sender = makeSender();
  const buf = new OutboundBuffer(makeRecord(), sender, 500, logger, {
    flushIntervalMs: 0,
    maxRetries: 0,
    retryBaseMs: 0,
  });

  buf.append('before\n```js\ncode line 1\ncode line 2');
  await buf.flush();
  // fence 未配平：配平边界前的 "before" 发出，未闭合代码块整体留在 buffer
  assert.equal(sender.calls.length, 1);
  assert.equal(sender.calls[0].content, 'before\n');
  assert.match(buf.text, /```js/);

  buf.append('\ncode line 3\n```\nafter');
  await buf.flush();
  // 配平后代码块整体送出
  assert.equal(sender.calls.length, 2);
  assert.match(sender.calls[1].content, /code line 3/);
  assert.match(sender.calls[1].content, /after/);
  assert.equal(buf.text, '');
});

test('finalize: waits for in-flight retry chain and sends remainder exactly once', async () => {
  const calls = [];
  let failFirst = true;
  const sender = {
    async sendMarkdown(target, content) {
      if (failFirst) {
        failFirst = false;
        throw new Error('transient');
      }
      calls.push(content);
    },
  };
  const buf = new OutboundBuffer(makeRecord(), sender, 100, logger, {
    flushIntervalMs: 0,
    maxRetries: 3,
    retryBaseMs: 5,
  });

  buf.append('tail content');
  const flushing = buf.flush();          // 在途，将失败一次并退避
  await new Promise((resolve) => setTimeout(resolve, 1));
  const done = buf.finalize();           // 退避在途时 finalize
  await Promise.all([flushing, done]);

  assert.deepEqual(calls, ['tail content']); // 恰好一次送达，无重复
  assert.equal(buf.text, '');
});

test('finalize is idempotent: concurrent calls resolve to the same completion', async () => {
  const sender = makeSender();
  const buf = new OutboundBuffer(makeRecord(), sender, 100, logger, {
    flushIntervalMs: 0,
    maxRetries: 1,
    retryBaseMs: 1,
  });

  buf.append('x');
  await Promise.all([buf.finalize(), buf.finalize(), buf.finalize()]);

  assert.equal(sender.calls.length, 1);
});

test('compat: no options keeps legacy manual flush/cancel semantics', async () => {
  const sender = makeSender();
  const buf = new OutboundBuffer(makeRecord(), sender, 100, logger);

  buf.append('a');
  buf.append('b');
  assert.equal(buf.text, 'ab');

  buf.cancel();
  assert.equal(buf.text, '');
  await buf.flush();
  assert.equal(sender.calls.length, 0);
});

test('dedupe: assistant/message after partial incremental flush only sends the tail', async () => {
  // 模拟真实时序：流式 chunk 先增量送达 "hello world"，然后 assistant/message
  // 携带权威全文到达，此时已送达部分不应重发，只补发未送达的 "!"。
  const sender = makeSender();
  const buf = new OutboundBuffer(makeRecord(), sender, 100, logger, {
    flushIntervalMs: 50,
    maxRetries: 2,
    retryBaseMs: 10,
  });

  buf.append('hello world');
  await buf.flush(); // 增量已送达 "hello world"
  assert.equal(sender.calls.length, 1);
  assert.equal(sender.calls[0].content, 'hello world');
  assert.equal(buf.deliveredChars, 11);

  // assistant/message 到达，全文 = "hello world!"
  await buf.finalizeWith('hello world!');
  assert.equal(sender.calls.length, 2);
  assert.equal(sender.calls[1].content, '!');
  assert.equal(buf.text, '');
});

test('dedupe: assistant/message full text fully delivered by streaming sends nothing extra', async () => {
  const sender = makeSender();
  const buf = new OutboundBuffer(makeRecord(), sender, 100, logger, {
    flushIntervalMs: 50,
    maxRetries: 2,
    retryBaseMs: 10,
  });

  buf.append('entire reply already streamed');
  await buf.flush();
  assert.equal(sender.calls.length, 1);

  // 权威全文与已送达完全一致：不产生任何额外发送
  await buf.finalizeWith('entire reply already streamed');
  assert.equal(sender.calls.length, 1);
  assert.equal(buf.text, '');
});

test('empty/whitespace buffer never triggers a send', async () => {
  const sender = makeSender();
  const buf = new OutboundBuffer(makeRecord(), sender, 100, logger, {
    flushIntervalMs: 5,
    maxRetries: 1,
    retryBaseMs: 1,
  });

  buf.append('   ');
  await buf.finalize();
  assert.equal(sender.calls.length, 0);
});
