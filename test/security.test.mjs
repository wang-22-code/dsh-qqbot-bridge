import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSecurityConfig, peerFingerprint } from '../dist/security.js';

function config(overrides = {}) {
  return {
    appId: 'app',
    appSecret: 'secret',
    cwd: './workspace',
    requireMention: true,
    textChunkLimit: 4500,
    sessionIdleTimeout: 1_800_000,
    maxQueue: 20,
    processingTimeoutMs: 120_000,
    historyLimit: 10,
    access: { c2cMode: 'allowlist', c2cAllow: [], groupMode: 'disabled', groupAllow: [] },
    acknowledgeOpenAccess: false,
    allowUnsafeCwd: false,
    logMessageContent: false,
    debug: false,
    ...overrides,
  };
}

test('empty allowlist fails closed with a warning', () => {
  const result = validateSecurityConfig(config());
  assert.equal(result.errors.length, 0);
  assert.match(result.warnings.join('\n'), /白名单为空/);
});

test('open access requires explicit acknowledgement', () => {
  const result = validateSecurityConfig(config({
    access: { c2cMode: 'open', c2cAllow: [], groupMode: 'disabled', groupAllow: [] },
  }));
  assert.match(result.errors.join('\n'), /acknowledgeOpenAccess/);
});

test('deepseek-official without DEEPSEEK_API_KEY warns', () => {
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const result = validateSecurityConfig(config({ provider: 'deepseek-official' }));
    assert.match(result.warnings.join('\n'), /DEEPSEEK_API_KEY/);
  } finally {
    if (saved) process.env.DEEPSEEK_API_KEY = saved;
  }
});

test('other provider without DEEPSEEK_API_KEY does not warn', () => {
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const result = validateSecurityConfig(config({ provider: 'openai-compatible' }));
    assert.equal(result.warnings.some((w) => /DEEPSEEK_API_KEY/.test(w)), false);
  } finally {
    if (saved) process.env.DEEPSEEK_API_KEY = saved;
  }
});

test('peer fingerprints are stable and do not expose the OpenID', () => {
  const openid = 'user-openid-sensitive';
  const value = peerFingerprint(openid);
  assert.equal(value, peerFingerprint(openid));
  assert.equal(value.length, 12);
  assert.equal(value.includes(openid), false);
});
