/**
 * Unit tests for the image quality check (resolution and blur).
 * Run with `npm test`. No network or keys needed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { laplacianVariance, evaluateQuality, analyzeQuality } = require('../src/imageQuality');

const sample = (name) => fs.readFileSync(path.join(__dirname, '..', 'test-images', name));

// Same defaults as the app.
const rules = { minWidth: 300, minHeight: 300, minSharpness: 100 };

// --- Blur measurement ----------------------------------------------------------

test('a completely flat image has sharpness 0', () => {
  const flat = new Uint8Array(20 * 20).fill(128);
  assert.strictEqual(laplacianVariance(flat, 20, 20), 0);
});

test('a black-and-white checkerboard (all hard edges) has high sharpness', () => {
  const size = 20;
  const board = new Uint8Array(size * size).map((_, i) => ((i % size) + Math.floor(i / size)) % 2 ? 255 : 0);
  assert.ok(laplacianVariance(board, size, size) > 10000);
});

test('sample sharp image scores well above the blur threshold', async () => {
  const q = await analyzeQuality(sample('sharp.jpg'));
  assert.deepStrictEqual([q.width, q.height], [800, 600]);
  assert.ok(q.sharpness > 1000, `expected > 1000, got ${q.sharpness}`);
});

test('sample blurry image scores below the blur threshold', async () => {
  const q = await analyzeQuality(sample('blurry.jpg'));
  assert.ok(q.sharpness < rules.minSharpness, `expected < ${rules.minSharpness}, got ${q.sharpness}`);
});

// --- Quality rules -------------------------------------------------------------

test('passes a large, sharp image', () => {
  assert.deepStrictEqual(evaluateQuality({ width: 1200, height: 800, sharpness: 400 }, rules), { ok: true, problems: [] });
});

test('rejects an image below the minimum resolution', () => {
  const r = evaluateQuality({ width: 240, height: 180, sharpness: 2400 }, rules);
  assert.strictEqual(r.ok, false);
  assert.match(r.problems[0], /Resolution too low: 240x180/);
});

test('rejects a blurry image', () => {
  const r = evaluateQuality({ width: 800, height: 600, sharpness: 7.3 }, rules);
  assert.strictEqual(r.ok, false);
  assert.match(r.problems[0], /too blurry/);
});

test('reports both problems when an image is small AND blurry', () => {
  const r = evaluateQuality({ width: 200, height: 200, sharpness: 15.6 }, rules);
  assert.strictEqual(r.problems.length, 2);
});
