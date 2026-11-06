import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPolishFilter, polishWav } from '../dist/voice/polish.js';

test('buildPolishFilter contains expected stages', () => {
  const f = buildPolishFilter(0.9, 200, 350);
  assert.match(f, /silenceremove=stop_periods=-1/);
  assert.match(f, /atempo=0\.9/);
  assert.match(f, /loudnorm=I=-16/);
  assert.match(f, /adelay=200/);
  assert.match(f, /apad=pad_dur=0\.350/);
  assert.match(f, /aresample=24000/);
});

test('polishWav returns the same file for non-WAV / tiny input (no crash)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'polish-'));
  try {
    const f = join(dir, 'tiny.wav');
    writeFileSync(f, Buffer.from([1, 2, 3]));
    const out = polishWav(f);
    assert.equal(out, f); // skipped, unchanged
    assert.equal(existsSync(f), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('polishWav returns the same file when provider path exists and data is valid-ish', () => {
  // 44-byte RIFF header + minimal data; ffmpeg may fail on bogus but must not throw and must return a valid path
  const dir = mkdtempSync(join(tmpdir(), 'polish2-'));
  try {
    const f = join(dir, 'riff.wav');
    const buf = Buffer.alloc(44);
    buf.write('RIFF', 0); buf.write('WAVE', 8);
    writeFileSync(f, buf);
    const out = polishWav(f);
    assert.ok(typeof out === 'string' && out.length > 0);
    assert.equal(existsSync(out), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
