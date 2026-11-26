/**
 * ============================================================================
 *  Score images with OpenAI moderation (developer tool, not deployed)
 * ============================================================================
 *
 *  Runs images through the same moderation check the upload endpoint uses,
 *  and prints each one's scores and verdict. Nothing is uploaded or stored.
 *
 *  Use it to:
 *    - check how a new or borderline image would be treated
 *    - re-tune the thresholds (e.g. after OpenAI upgrades its model)
 *
 *  Usage:
 *    node scripts/score.js <image> [<image> ...]
 *
 *  Example output:
 *    knife.png (image/png, 1261892 bytes)
 *      BLOCK (3042 ms) sexual=0.0001 violence=0.834 violence/graphic=0.0035 ...
 *
 *  The OpenAI key and thresholds are read from local.settings.json, so no
 *  secrets need to be typed on the command line.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

// Load the settings from local.settings.json into process.env.
// This must happen BEFORE loading the moderation module, because it reads
// its thresholds from process.env when it loads.
const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'local.settings.json'), 'utf8'));
Object.assign(process.env, settings.Values);

const { detectImageType } = require('../src/imageType');
const { checkQuality } = require('../src/imageQuality');
const { moderate } = require('../src/moderation');

(async () => {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('Usage: node scripts/score.js <image> [<image> ...]');
    process.exit(1);
  }

  for (const file of files) {
    const buffer = fs.readFileSync(file);
    const kind = detectImageType(buffer);
    console.log(`\n${path.basename(file)} (${kind ? kind.type : 'unsupported type'}, ${buffer.length} bytes)`);
    if (!kind) continue; // not a supported image, nothing to check

    // Quality check (resolution and blur), the same as the endpoint's Step 4.
    const q = await checkQuality(buffer);
    console.log(`  quality: ${q.ok ? 'PASS' : 'FAIL'} ${q.quality.width}x${q.quality.height} sharpness=${q.quality.sharpness}${q.ok ? '' : ' -> ' + q.problems.join('; ')}`);

    // Moderation (the endpoint's Step 5). Runs even if quality failed, so you
    // can see both results while tuning.
    try {
      const started = Date.now();
      const verdict = await moderate(buffer, kind.type);
      const scores = Object.entries(verdict.scores).map(([k, s]) => `${k}=${s}`).join(' ');
      console.log(`  moderation: ${verdict.allowed ? 'ALLOW' : 'BLOCK'} (${Date.now() - started} ms) ${scores}`);
    } catch (err) {
      console.log(`  ERROR ${err.message}`);
    }
  }
})();
