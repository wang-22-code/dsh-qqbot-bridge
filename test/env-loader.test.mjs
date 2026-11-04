import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvContent, loadEnvFiles } from '../dist/shared/env-loader.js';

test('parseEnvContent handles quotes, export, comments, inline comments', () => {
  const content = [
    '# comment line',
    'PLAIN=value',
    'export EXPORTED=yes',
    'DQ="hello world"',
    "SQ='single value'",
    'INLINE=abc # trailing',
    '',
    'NOT_A_LINE',
  ].join('\n');
  const env = parseEnvContent(content);
  assert.equal(env.PLAIN, 'value');
  assert.equal(env.EXPORTED, 'yes');
  assert.equal(env.DQ, 'hello world');
  assert.equal(env.SQ, 'single value');
  assert.equal(env.INLINE, 'abc');
  assert.equal('NOT_A_LINE' in env, false);
});

test('loadEnvFiles fills missing keys but never overrides existing non-empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'env-load-'));
  try {
    const f = join(dir, '.env');
    writeFileSync(f, 'A=1\nB=2\nC=\n', 'utf8');
    const env = { B: 'existing' };
    const res = loadEnvFiles([f], env);
    assert.equal(env.A, '1'); // filled
    assert.equal(env.B, 'existing'); // not overridden
    assert.equal(env.C, ''); // empty stays empty (treated as missing -> set to '')
    assert.deepEqual(res.files, [f]);
    assert.ok(res.keys.includes('A'));
    assert.equal(res.keys.includes('B'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadEnvFiles ignores missing files and reports nothing', () => {
  const res = loadEnvFiles(['D:/no/such/file.env'], {});
  assert.deepEqual(res.files, []);
  assert.deepEqual(res.keys, []);
});
