/**
 * Unit tests for reading the AI quality model's answer.
 * Run with `npm test`. No network or keys needed (the model is not called).
 */

const test = require('node:test');
const assert = require('node:assert');
const { parseVerdict, isContentFilterError } = require('../src/llmQuality');

test('reads an "acceptable" answer', () => {
  const v = parseVerdict('{"acceptable":true,"problems":[],"reason":"Sharp, clean photo."}');
  assert.deepStrictEqual(v, { acceptable: true, problems: [], reason: 'Sharp, clean photo.' });
});

test('reads a rejection with problems', () => {
  const v = parseVerdict('{"acceptable":false,"problems":["pixelated","upscaled"],"reason":"Blocky edges."}');
  assert.strictEqual(v.acceptable, false);
  assert.deepStrictEqual(v.problems, ['pixelated', 'upscaled']);
});

test('drops problem names that are not on the fixed list', () => {
  const v = parseVerdict('{"acceptable":false,"problems":["blurry","ugly"],"reason":"x"}');
  assert.deepStrictEqual(v.problems, ['blurry']);
});

test('throws on a non-JSON answer (caller then fails closed)', () => {
  assert.throws(() => parseVerdict('looks fine to me'), /invalid JSON/);
});

test('throws on a missing answer', () => {
  assert.throws(() => parseVerdict(undefined));
});

test('throws on JSON with the wrong shape', () => {
  assert.throws(() => parseVerdict('{"ok":true}'), /unexpected answer/);
});

test('recognises an Azure content filter error', () => {
  assert.strictEqual(isContentFilterError({ status: 400, code: 'content_filter' }), true);
  assert.strictEqual(isContentFilterError({ status: 400, code: 'invalid_image' }), false);
});
