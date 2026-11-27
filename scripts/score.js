/**
 * ============================================================================
 *  Score images with every upload check (developer tool, not deployed)
 * ============================================================================
 *
 *  Runs images through the same checks the upload endpoint uses (local
 *  quality, OpenAI moderation, Azure OpenAI quality model) and prints each
 *  result. Nothing is uploaded or stored.
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
 *      quality: PASS 1200x822 sharpness=416.7
 *      moderation: BLOCK (3042 ms) sexual=0.0001 violence=0.834 ...
 *      ai quality: PASS (2100 ms, 1200 tokens) [] Sharp, well-exposed photo.
 *
 *  Keys and thresholds are read from local.settings.json, so no secrets need
 *  to be typed on the command line. Each run makes one billed Azure OpenAI
 *  call per image.
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
const { judgeQuality } = require('../src/llmQuality');

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

    // The two AI checks (the endpoint's Step 5), run in parallel like the
    // endpoint does. They run even if the local check failed, so you can see
    // every result while tuning. Note: the AI quality call is billed.
    const timed = async (fn) => { const t = Date.now(); const r = await fn(); return { r, ms: Date.now() - t }; };
    const [safety, aiQuality] = await Promise.allSettled([
      timed(() => moderate(buffer, kind.type)),
      timed(() => judgeQuality(buffer, kind.type)),
    ]);

    if (safety.status === 'fulfilled') {
      const { r: verdict, ms } = safety.value;
      const scores = Object.entries(verdict.scores).map(([k, s]) => `${k}=${s}`).join(' ');
      console.log(`  moderation: ${verdict.allowed ? 'ALLOW' : 'BLOCK'} (${ms} ms) ${scores}`);
    } else {
      console.log(`  moderation: ERROR ${safety.reason.message}`);
    }

    if (aiQuality.status === 'fulfilled') {
      const { r: v, ms } = aiQuality.value;
      console.log(`  ai quality: ${v.acceptable ? 'PASS' : 'FAIL'} (${ms} ms, ${v.tokens} tokens) [${v.problems.join(', ')}] ${v.reason}`);
    } else {
      console.log(`  ai quality: ERROR ${aiQuality.reason.message}`);
    }
  }
})();
