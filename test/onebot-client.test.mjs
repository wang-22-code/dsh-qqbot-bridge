import assert from 'node:assert/strict';
import test from 'node:test';
import { OneBotClient } from '../dist/transport/onebot/client.js';
import { OneBotApi } from '../dist/transport/onebot/api.js';
import { OneBotSender } from '../dist/transport/onebot/sender.js';

function fakeLogger() {
  const logs = [];
  const push = (lvl) => (m) => logs.push(`${lvl}:${m}`);
  return { info: push('i'), warn: push('w'), error: push('e'), debug: push('d'), logs };
}

class FakeWS {
  static last = null;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    this.sent = [];
    FakeWS.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open', {});
    });
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type, ev) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
  send(data) {
    this.sent.push(data);
    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      return;
    }
    if (!obj || !obj.action) return;
    const payload =
      obj.action === 'get_login_info'
        ? { status: 'ok', retcode: 0, data: { user_id: 42, nickname: 'bot' }, echo: obj.echo }
        : { status: 'ok', retcode: 0, data: { message_id: 100 }, echo: obj.echo };
    queueMicrotask(() => this.emit('message', { data: JSON.stringify(payload) }));
  }
  close() {
    this.readyState = 3;
    this.emit('close', { code: 1000 });
  }
}

test('OneBotClient connects, resolves echo calls, and dispatches events', async () => {
  const orig = globalThis.WebSocket;
  globalThis.WebSocket = FakeWS;
  try {
    const logger = fakeLogger();
    const received = [];
    const client = new OneBotClient({ url: 'ws://127.0.0.1:1', accessToken: 'tk', logger });
    client.onEvent = (e) => received.push(e);
    await client.start();
    assert.equal(client.isOpen, true);

    const api = new OneBotApi(client);
    const info = await api.getLoginInfo();
    assert.equal(info.user_id, 42);

    FakeWS.last.emit('message', {
      data: JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        user_id: 7,
        message: [{ type: 'text', data: { text: 'hi' } }],
      }),
    });
    assert.equal(received.length, 1);
    assert.equal(received[0].post_type, 'message');
  } finally {
    globalThis.WebSocket = orig;
  }
});

test('OneBotSender maps scope to private/group sends and voice records', async () => {
  const calls = [];
  const fakeClient = {
    call: async (action, params) => {
      calls.push({ action, params });
      return {};
    },
  };
  const api = new OneBotApi(fakeClient);
  const sender = new OneBotSender(api);

  await sender.sendMarkdown({ scope: 'c2c', targetId: '123', msgId: '1' }, 'hello');
  await sender.sendMarkdown({ scope: 'group', targetId: '456' }, 'hi group');
  await sender.sendVoice({ scope: 'c2c', targetId: '123' }, '/tmp/a.wav');

  assert.equal(calls[0].action, 'send_private_msg');
  assert.equal(calls[0].params.user_id, 123);
  assert.equal(calls[0].params.message[0].type, 'text');
  assert.equal(calls[0].params.message[0].data.text, 'hello');

  assert.equal(calls[1].action, 'send_group_msg');
  assert.equal(calls[1].params.group_id, 456);

  assert.equal(calls[2].action, 'send_private_msg');
  assert.equal(calls[2].params.message[0].type, 'record');
  assert.equal(calls[2].params.message[0].data.file, '/tmp/a.wav');
});
