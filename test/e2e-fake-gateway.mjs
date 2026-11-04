/**
 * test/e2e-fake-gateway.mjs
 *
 * A minimal, dependency-free fake OneBot v11 **forward WebSocket** gateway used
 * for end-to-end tests of this plugin (channel=onebot). No real QQ / NapCat
 * required.
 *
 * Why hand-rolled?  We deliberately avoid adding any npm dependency. The
 * WebSocket server here only implements the small subset OneBot needs:
 *   - HTTP `Upgrade` handshake (SHA-1 + magic GUID per RFC 6455)
 *   - parsing **masked** client frames (text / ping / close / fragmented)
 *   - sending **unmasked** server frames (text / pong)
 *
 * Reliability note (the bug we are fixing): the previous throw-away script
 * pushed the scripted message only on the *first* connection (it gated on a
 * global `socks.size === 1`). This module instead wires a **per-connection**
 * timer chain, so every fresh connection independently replays the script.
 *
 * Environment variables:
 *   E2E_PORT     listen port                  (default 3101)
 *   E2E_MSGS     JSON array overriding the pushed messages. Each element is
 *                either a plain string (used as the private-message text) or a
 *                full message-event object (pushed verbatim).
 *                Default: one private message "你好" from user 123456789.
 *   E2E_GAP_MS   gap between successive pushes (default 8000 ms)
 *   E2E_FIRST_MS delay before the first push    (default 6000 ms)
 *   E2E_OUT      JSONL file for received actions (default e2e-actions.jsonl)
 *
 * stdout protocol (consumed by test harnesses):
 *   LISTEN <port>      once, when the server is accepting connections
 *   CONNECT <n>        each new client connection (1-based, monotonic)
 *   PUSH <text>        each message event pushed to a client
 *
 * The process stays alive until it is killed (SIGINT / SIGTERM handled).
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HOST = '127.0.0.1';
const PORT = Number(process.env.E2E_PORT || 3101);
const OUT_FILE = process.env.E2E_OUT || 'e2e-actions.jsonl';
const GAP_MS = Number(process.env.E2E_GAP_MS || 8000);
const FIRST_MS = Number(process.env.E2E_FIRST_MS || 6000);

/** RFC 6455 magic GUID used to derive `Sec-WebSocket-Accept`. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Default identity used for the scripted private message. */
const DEFAULT_USER_ID = 123456789;
const DEFAULT_NICKNAME = '测试用户';

// ---------------------------------------------------------------------------
// Scripted messages
// ---------------------------------------------------------------------------

/**
 * Build a default OneBot private-message event carrying a single text segment.
 * `message_id` is randomized and `time` is seconds, matching OneBot v11.
 *
 * @param {string} text
 * @returns {object}
 */
function defaultEvent(text) {
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: DEFAULT_USER_ID,
    self_id: 0,
    message_id: Math.floor(Math.random() * 1e9),
    time: Math.floor(Date.now() / 1000),
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: DEFAULT_USER_ID, nickname: DEFAULT_NICKNAME },
  };
}

/**
 * Parse `E2E_MSGS` into a normalized script. Each entry is tagged with a kind:
 *   { kind: 'text', text }  -> wrapped into a default private-message event
 *   { kind: 'raw',  event } -> pushed verbatim
 *
 * @returns {Array<{kind:'text',text:string}|{kind:'raw',event:object}>}
 */
function loadScript() {
  const raw = process.env.E2E_MSGS;
  if (!raw || !raw.trim()) return [{ kind: 'text', text: '你好' }];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`E2E_MSGS is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    console.error('E2E_MSGS must be a non-empty JSON array');
    process.exit(1);
  }

  return parsed.map((item) =>
    typeof item === 'string'
      ? { kind: 'text', text: item }
      : { kind: 'raw', event: item },
  );
}

const SCRIPT = loadScript();

// ---------------------------------------------------------------------------
// WebSocket frame encoding (server -> client, never masked)
// ---------------------------------------------------------------------------

/**
 * Encode a single WebSocket frame.
 *
 * @param {number} opcode     0x1 text, 0x8 close, 0x9 ping, 0xA pong
 * @param {Buffer} payload
 * @returns {Buffer}
 */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f); // FIN set
  return Buffer.concat([header, payload]);
}

/** Encode a text frame from a JS string (UTF-8, unmasked). */
function encodeTextFrame(str) {
  return encodeFrame(0x1, Buffer.from(str, 'utf8'));
}

/** Encode a pong control frame echoing an optional payload. */
function encodePong(payload) {
  return encodeFrame(0xa, payload);
}

// ---------------------------------------------------------------------------
// WebSocket frame parsing (client -> server, normally masked)
// ---------------------------------------------------------------------------

/**
 * Create a stateful frame reader for one socket. Feed it each `data` chunk;
 * it invokes the supplied handlers for complete messages/control frames.
 *
 * Supports text frames and simple fragmentation (continuation frames) since
 * some clients may split large payloads.
 *
 * @param {{
 *   onText: (text: string) => void,
 *   onPing: (payload: Buffer) => void,
 *   onClose: () => void,
 * }} handlers
 * @returns {(chunk: Buffer) => void}
 */
function createFrameReader(handlers) {
  let buffer = Buffer.alloc(0);
  let fragmentOpcode = 0; // opcode of the message being reassembled
  let fragments = []; // collected continuation payloads

  const dispatch = (opcode, payload) => {
    switch (opcode) {
      case 0x1:
        handlers.onText(payload.toString('utf8'));
        break;
      case 0x8:
        handlers.onClose();
        break;
      case 0x9:
        handlers.onPing(payload);
        break;
      default:
        // 0x2 binary, 0xA pong, etc. — ignore.
        break;
    }
  };

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    for (;;) {
      if (buffer.length < 2) return;

      const b0 = buffer[0];
      const b1 = buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buffer.length < offset + 2) return;
        len = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buffer.length < offset + 8) return;
        len = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + len) return; // incomplete frame

      let mask = null;
      if (masked) {
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      const payload = Buffer.from(buffer.subarray(offset, offset + len));
      if (mask) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      }
      buffer = buffer.subarray(offset + len);

      if (opcode === 0x0) {
        // Continuation of a fragmented message.
        fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(fragments);
          const op = fragmentOpcode;
          fragments = [];
          fragmentOpcode = 0;
          dispatch(op, full);
        }
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          dispatch(opcode, payload);
        } else {
          fragmentOpcode = opcode;
          fragments = [payload];
        }
      } else {
        // Control frames (ping/close/pong) are never fragmented.
        dispatch(opcode, payload);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Action recording (JSONL, with base64 record scrubbing)
// ---------------------------------------------------------------------------

/**
 * Deep-copy `value`, replacing any OneBot `record` segment that embeds a
 * base64/file payload with a compact `{ type:'record', fileChars: <length> }`.
 * This keeps the log small and avoids leaking potentially sensitive audio.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    if (value.type === 'record' && value.data && typeof value.data.file === 'string') {
      return { type: 'record', fileChars: value.data.file.length };
    }
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = scrub(val);
    return out;
  }
  return value;
}

/**
 * Append one received action to the JSONL log.
 *
 * @param {string} action
 * @param {unknown} params
 */
function recordAction(action, params) {
  const line = JSON.stringify({ t: Date.now(), action, params: scrub(params) });
  try {
    appendFileSync(OUT_FILE, `${line}\n`, 'utf8');
  } catch (err) {
    console.error(`failed to append to E2E_OUT (${OUT_FILE}): ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Per-connection scripted pushing
// ---------------------------------------------------------------------------

/**
 * Human-readable summary of a pushed event for the `PUSH <text>` line.
 *
 * @param {object} event
 * @returns {string}
 */
function describeEvent(event) {
  const segments = Array.isArray(event?.message) ? event.message : [];
  const texts = segments
    .filter((s) => s && s.type === 'text' && s.data && typeof s.data.text === 'string')
    .map((s) => s.data.text);
  if (texts.length > 0) return texts.join('');
  // Fall back to the raw message (or the whole event) as JSON.
  return JSON.stringify(event?.message ?? event);
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

let connectionSeq = 0;
let messageIdSeq = 1000;
const openSockets = new Set();

const server = http.createServer((req, res) => {
  // Plain HTTP requests are not part of the protocol; answer politely.
  res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('This endpoint speaks WebSocket (OneBot v11 forward WS).\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || key.length === 0) {
    socket.destroy();
    return;
  }

  // Complete the RFC 6455 handshake.
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  const connId = ++connectionSeq;
  openSockets.add(socket);
  console.log(`CONNECT ${connId}`);

  let closed = false;
  const timers = new Set();

  /** Send one JSON payload as an unmasked text frame, if still open. */
  const sendJson = (obj) => {
    if (closed) return;
    try {
      socket.write(encodeTextFrame(JSON.stringify(obj)));
    } catch {
      /* socket gone; cleanup will run via 'close'/'error' */
    }
  };

  /**
   * Replay the script for THIS connection only. Uses its own chained timers,
   * so a second connection starts a fresh, independent push sequence.
   */
  const pushNext = (index) => {
    if (closed || index >= SCRIPT.length) return;
    const item = SCRIPT[index];
    const event = item.kind === 'raw' ? item.event : defaultEvent(item.text);
    sendJson(event);
    console.log(`PUSH ${describeEvent(event)}`);
    if (index + 1 < SCRIPT.length) {
      const t = setTimeout(() => pushNext(index + 1), GAP_MS);
      timers.add(t);
    }
  };
  timers.add(setTimeout(() => pushNext(0), FIRST_MS));

  const cleanup = () => {
    if (closed) return;
    closed = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    openSockets.delete(socket);
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  };

  const reader = createFrameReader({
    onText: (text) => {
      let obj;
      try {
        obj = JSON.parse(text);
      } catch {
        return; // not JSON — ignore
      }
      if (!obj || typeof obj !== 'object' || typeof obj.action !== 'string') return;

      // Log the received action (scrubbed) before replying.
      recordAction(obj.action, obj.params);

      // OneBot API reply envelope. `get_login_info` gets a bot identity;
      // everything else (e.g. send_private_msg) gets a message_id.
      const data =
        obj.action === 'get_login_info'
          ? { user_id: 0, nickname: 'bot' }
          : { message_id: ++messageIdSeq };
      sendJson({ status: 'ok', retcode: 0, data, echo: obj.echo });
    },
    onPing: (payload) => {
      // Echo a pong so a client-side keepalive stays happy.
      if (!closed) {
        try {
          socket.write(encodePong(payload));
        } catch {
          /* ignore */
        }
      }
    },
    onClose: () => cleanup(),
  });

  socket.on('data', reader);
  socket.on('end', cleanup);
  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

server.on('error', (err) => {
  console.error(`server error: ${err.message}`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : PORT;
  console.log(`LISTEN ${port}`);
});

// Graceful shutdown so test harnesses can stop us cleanly.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const socket of openSockets) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
    openSockets.clear();
    server.close(() => process.exit(0));
    // Fallback if close hangs on lingering keep-alive connections.
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
