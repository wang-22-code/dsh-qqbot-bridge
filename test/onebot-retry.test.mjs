import assert from 'node:assert/strict';
import test from 'node:test';
import { OneBotApi } from '../dist/transport/onebot/api.js';

test('OneBotApi retries connection errors then succeeds', async () => {
  let calls = 0;
  let lastParams = null;
  const fakeClient = {
    call: async (action, params) => {
      calls += 1;
      lastParams = params;
      if (calls < 2) throw new Error('OneBot 未连接');
      return { message_id: 1 };
    },
  };
  const api = new OneBotApi(fakeClient);
  const res = await api.sendPrivateMsg(123, 'hi');
  assert.equal(calls, 2);
  assert.deepEqual(res, { message_id: 1 });
  assert.equal(lastParams.user_id, 123);
});

test('OneBotApi does not retry business errors (retcode)', async () => {
  let calls = 0;
  const fakeClient = {
    call: async () => {
      calls += 1;
      throw new Error('OneBot action 失败 retcode=100');
    },
  };
  const api = new OneBotApi(fakeClient);
  await assert.rejects(() => api.sendGroupMsg(1, 'x'), /retcode=100/);
  assert.equal(calls, 1);
});
