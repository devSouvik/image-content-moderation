/**
 * Unit tests: run with `npm test`.
 *
 * These test the decision logic only:
 *   - Is the file a real, supported image? (detectImageType)
 *   - Given a set of scores, is the image allowed or blocked? (evaluate)
 *
 * They never call OpenAI, so they are free, fast, and need no keys or
 * network. To score real images against OpenAI, use scripts/score.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const { detectImageType } = require('../src/imageType');
const { evaluate } = require('../src/moderation');

// --- File type detection -----------------------------------------------------

test('detects supported image types from magic bytes', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);
  assert.strictEqual(detectImageType(png).type, 'image/png');
  assert.strictEqual(detectImageType(jpg).type, 'image/jpeg');
  assert.strictEqual(detectImageType(Buffer.from('not an image at all')), null);
});

test('AVIF renamed to .jpeg is rejected', () => {
  // "....ftypavif" - the header of the AVIF file that failed in Postman
  const avif = Buffer.from('0000002066747970617669660000000000', 'hex');
  assert.strictEqual(detectImageType(avif), null);
});

test('BMP is rejected (OpenAI does not accept it)', () => {
  const bmp = Buffer.concat([Buffer.from('BM'), Buffer.alloc(12)]);
  assert.strictEqual(detectImageType(bmp), null);
});

// --- Moderation policy (scores 0-1) --------------------------------------------

// Same defaults as the app. `safeScores` looks like a typical harmless photo.
// The last argument to evaluate() is "also block when OpenAI flags it".
const limits = { sexual: 0.3, violence: 0.4, 'violence/graphic': 0.3, 'self-harm': 0.3 };
const safeScores = { sexual: 0.001, violence: 0.02, 'violence/graphic': 0.001, 'self-harm': 0 };

test('allows a safe image', () => {
  const r = evaluate({ flagged: false, categories: {}, scores: safeScores }, limits, true);
  assert.deepStrictEqual(r, { allowed: true, violations: [] });
});

test('blocks when a score reaches its threshold', () => {
  const r = evaluate({ flagged: false, categories: {}, scores: { ...safeScores, violence: 0.4 } }, limits, true);
  assert.strictEqual(r.allowed, false);
  assert.deepStrictEqual(r.violations, [{ category: 'violence', score: 0.4, threshold: 0.4 }]);
});

test('blocks when OpenAI flags it, even under our thresholds', () => {
  const analysis = { flagged: true, categories: { sexual: true }, scores: { ...safeScores, sexual: 0.2 } };
  const r = evaluate(analysis, limits, true);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.violations[0].threshold, 'openai-flagged');
});

test('ignores the OpenAI flag when blockOnFlagged is off', () => {
  const analysis = { flagged: true, categories: { sexual: true }, scores: { ...safeScores, sexual: 0.2 } };
  assert.strictEqual(evaluate(analysis, limits, false).allowed, true);
});
