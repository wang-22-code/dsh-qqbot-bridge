import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNapCatQrPayload, fetchNapCatQrcode } from '../dist/transport/onebot/index.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

test('parseNapCatQrPayload handles base64 image, url field, and url-as-qrcode', () => {
  const a = parseNapCatQrPayload({ data: { qrcode: 'BASE64DATA' } });
  assert.equal(a.qrcodeBase64, 'BASE64DATA');

  const b = parseNapCatQrPayload({ data: { url: 'https://napcat/qr' } });
  assert.equal(b.qrUrl, 'https://napcat/qr');

  const c = parseNapCatQrPayload({ qrcode: 'https://example.com/qr.png' });
  assert.equal(c.qrUrl, 'https://example.com/qr.png');
});

test('fetchNapCatQrcode saves a PNG from base64 payload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'napcat-'));
  try {
    const png = Buffer.from([137, 80, 78, 71]).toString('base64');
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { qrcode: png } }),
    });
    const res = await fetchNapCatQrcode({
      webuiUrl: 'http://127.0.0.1:6099/',
      token: 't',
      logger: silent,
      fetchImpl: fakeFetch,
      outDir: dir,
    });
    assert.equal(res.ok, true);
    assert.ok(res.file && existsSync(res.file));
    assert.equal(statSync(res.file).size, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetchNapCatQrcode reports failure on HTTP error / empty payload', async () => {
  const failing = async () => ({ ok: false, status: 403, json: async () => ({}) });
  const res = await fetchNapCatQrcode({
    webuiUrl: 'http://127.0.0.1:6099',
    logger: silent,
    fetchImpl: failing,
  });
  assert.equal(res.ok, false);
  assert.match(res.message, /403|失败/);
});
