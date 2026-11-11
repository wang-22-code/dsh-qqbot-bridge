import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { OneBotClient } from '../dist/transport/onebot/client.js';
import { OneBotApi } from '../dist/transport/onebot/api.js';
import { OneBotSender } from '../dist/transport/onebot/sender.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeTextFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payload.length, 6);
  }
  return Buffer.concat([header, payload]);
}

function parseFrames(state, chunk) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  const out = [];
  for (;;) {
    const buf = state.buffer;
    if (buf.length < 2) break;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = buf.readUInt32BE(6);
      offset = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) break;
    const mask = masked ? buf.slice(offset, offset + 4) : null;
    offset += maskLen;
    const payload = Buffer.from(buf.slice(offset, offset + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    state.buffer = buf.slice(offset + len);
    if (opcode === 0x1) out.push({ type: 'text', text: payload.toString('utf8') });
    else if (opcode === 0x8) out.push({ type: 'close' });
    else if (opcode === 0x9) out.push({ type: 'ping' });
  }
  return out;
}

function createServer() {
  const actions = [];
  const sockets = new Set();
  let upgradeUrl = null;
  const server = http.createServer();

  server.on('upgrade', (req, socket) => {
    upgradeUrl = req.url ?? '';
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    const state = { buffer: Buffer.alloc(0) };
    socket.on('data', (chunk) => {
      for (const m of parseFrames(state, chunk)) {
        if (m.type !== 'text') continue;
        let obj;
        try {
          obj = JSON.parse(m.text);
        } catch {
          continue;
        }
        if (!obj || !obj.action) continue;
        actions.push(obj);
        const data =
          obj.action === 'get_login_info' ? { user_id: 42, nickname: 'nit' } : { message_id: 100 };
        socket.write(encodeTextFrame(JSON.stringify({ status: 'ok', retcode: 0, data, echo: obj.echo })));
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });

  return {
    actions,
    get upgradeUrl() {
      return upgradeUrl;
    },
    listen() {
      return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    },
    push(obj) {
      const frame = encodeTextFrame(JSON.stringify(obj));
      for (const s of sockets) s.write(frame);
    },
    close() {
      for (const s of sockets) {
        try {
          s.destroy();
        } catch {
          /* ignore */
        }
      }
      sockets.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function waitFor(fn, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let value;
      try {
        value = fn();
      } catch (err) {
        return reject(err);
      }
      if (value) return resolve(value);
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('end-to-end over a real WebSocket server: handshake, events, actions, sender', async () => {
  const srv = createServer();
  const port = await srv.listen();
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const client = new OneBotClient({ url: `ws://127.0.0.1:${port}/`, accessToken: 'tk', logger });
  try {
    const received = [];
    client.onEvent = (e) => received.push(e);
    await client.start();
    assert.match(srv.upgradeUrl, /access_token=tk/);

    const api = new OneBotApi(client);
    const info = await api.getLoginInfo();
    assert.equal(info.user_id, 42);

    srv.push({
      post_type: 'message',
      message_type: 'private',
      user_id: 7,
      message: [{ type: 'text', data: { text: 'hi' } }],
    });
    await waitFor(() => received.length > 0);
    assert.equal(received[0].post_type, 'message');

    const sender = new OneBotSender(api);
    await sender.sendMarkdown({ scope: 'group', targetId: '456' }, 'hello group');
    await waitFor(() => srv.actions.some((a) => a.action === 'send_group_msg'));
    const sent = srv.actions.find((a) => a.action === 'send_group_msg');
    assert.equal(sent.params.group_id, 456);
    assert.equal(sent.params.message[0].data.text, 'hello group');
  } finally {
    client.close();
    await srv.close();
  }
});
