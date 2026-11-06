import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkMarkdownText } from '../dist/transport/chunker.js';

test('splits on newline boundaries without exceeding limit', () => {
  const text = 'a\nb\nc';
  const chunks = chunkMarkdownText(text, 3);
  assert.ok(chunks.every((c) => c.length <= 3));
  assert.equal(chunks.join('\n'), text);
});

test('hard-splits a single overlong line', () => {
  const text = 'x'.repeat(250);
  const chunks = chunkMarkdownText(text, 100);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.length <= 100));
  assert.equal(chunks.join(''), text);
});

test('limit <= 0 returns the whole text unchanged', () => {
  assert.deepEqual(chunkMarkdownText('abc', 0), ['abc']);
});

test('short text stays a single chunk', () => {
  assert.deepEqual(chunkMarkdownText('hello', 100), ['hello']);
});
