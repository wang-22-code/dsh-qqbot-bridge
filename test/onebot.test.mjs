import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseSegments,
  extractText,
  isMentioned,
  shouldAccept,
  normalizeTarget,
  buildInboundText,
} from '../dist/transport/onebot/inbound.js';

function baseConfig(overrides = {}) {
  return {
    access: {
      c2cMode: 'allowlist',
      c2cAllow: [],
      groupMode: 'disabled',
      groupAllow: [],
      ...overrides,
    },
  };
}

test('parseSegments handles array and CQ-string forms', () => {
  const arr = parseSegments([
    { type: 'text', data: { text: '你好' } },
    { type: 'at', data: { qq: '123' } },
  ]);
  assert.equal(arr.length, 2);
  assert.equal(arr[1].type, 'at');

  const str = parseSegments('hi[CQ:image,file=a.jpg]there[CQ:at,qq=9]');
  assert.equal(str.length, 1);
  assert.equal(str[0].type, 'text');
  assert.match(str[0].data.text, /\[图片\]/);
});

test('extractText joins text and placeholders, strips @', () => {
  const text = extractText(parseSegments([
    { type: 'at', data: { qq: '123' } },
    { type: 'text', data: { text: ' 在吗' } },
    { type: 'face', data: { id: '1' } },
    { type: 'record', data: { file: 'x' } },
  ]));
  assert.equal(text, '@123 在吗[表情][语音]');
});

test('isMentioned matches the bot self id only', () => {
  const segs = parseSegments([{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: 'x' } }]);
  assert.equal(isMentioned(segs, '999'), true);
  assert.equal(isMentioned(segs, '123'), false);
  assert.equal(isMentioned(segs, ''), false);
});

test('shouldAccept enforces allowlist and disabled modes', () => {
  const event = { message_type: 'private', user_id: 10001, group_id: 555 };
  assert.equal(shouldAccept(baseConfig({ c2cMode: 'disabled' }), event, false), false);
  assert.equal(shouldAccept(baseConfig({ c2cMode: 'open' }), event, false), true);
  assert.equal(shouldAccept(baseConfig({ c2cMode: 'allowlist', c2cAllow: [] }), event, false), false);
  assert.equal(shouldAccept(baseConfig({ c2cMode: 'allowlist', c2cAllow: ['10001'] }), event, false), true);

  const groupEvent = { message_type: 'group', user_id: 10001, group_id: 555 };
  assert.equal(shouldAccept(baseConfig({ groupMode: 'allowlist', groupAllow: ['555'] }), groupEvent, true), true);
  assert.equal(shouldAccept(baseConfig({ groupMode: 'allowlist', groupAllow: ['556'] }), groupEvent, true), false);
});

test('normalizeTarget maps group and private correctly', () => {
  const priv = normalizeTarget({ message_type: 'private', user_id: 10001, message_id: 7 });
  assert.deepEqual(priv, { scope: 'c2c', targetId: '10001', msgId: '7' });

  const group = normalizeTarget({ message_type: 'group', user_id: 10001, group_id: 555, message_id: 8 });
  assert.deepEqual(group, { scope: 'group', targetId: '555', msgId: '8' });
});

test('buildInboundText tags group senders but not private', () => {
  const segs = parseSegments([{ type: 'text', data: { text: '你好' } }]);
  const priv = buildInboundText({ message_type: 'private', user_id: 10001 }, segs, false);
  assert.equal(priv, '你好');

  const group = buildInboundText(
    { message_type: 'group', user_id: 10001, sender: { nickname: '小明' } },
    segs,
    true,
  );
  assert.equal(group, '[小明 (10001)] 你好');
});
