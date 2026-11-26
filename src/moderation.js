/**
 * ============================================================================
 *  Image moderation: OpenAI Moderation API
 * ============================================================================
 *
 *  Sends an image to OpenAI's free moderation model and decides, using our
 *  own policy, whether it is safe to store.
 *
 *    Model:  omni-moderation-latest
 *    API:    POST https://api.openai.com/v1/moderations
 *    Docs:   https://developers.openai.com/api/docs/guides/moderation
 *    Cost:   free
 *
 *  HOW THE MODEL SCORES AN IMAGE
 *    For each category it returns a score from 0 to 1: how confident it is
 *    that the image contains that kind of content. 0 = clearly not present,
 *    1 = clearly present. For images, only these categories are scored:
 *
 *      sexual                   Sexual / NSFW content
 *      violence                 Death, violence or physical injury
 *      violence/graphic         The same, shown in graphic detail (e.g. gore)
 *      self-harm                Depictions of self-harm, such as cutting or suicide
 *      self-harm/intent         Self-harm the person shows they intend to do
 *      self-harm/instructions   Instructions or encouragement for self-harm
 *
 *    The other categories (hate, harassment, illicit, sexual/minors) work on
 *    text only. For an image on its own they always score 0.
 *
 *  OUR POLICY
 *    An image is BLOCKED if either:
 *      a) any score is at or above our threshold for that category, or
 *      b) OpenAI itself marks the image as "flagged" (can be switched off).
 *    Rule (b) means our thresholds can only make the check stricter than
 *    OpenAI's built-in defaults, never more lenient.
 *
 *  NOTE: OpenAI upgrades the model behind "omni-moderation-latest" from time
 *  to time. After an upgrade, re-check the thresholds with scripts/score.js.
 * ============================================================================
 */

/** Read a setting by name (Azure app settings or local.settings.json). */
const env = (name, fallback) => process.env[name] ?? fallback;

const MODEL = 'omni-moderation-latest';
const API_URL = 'https://api.openai.com/v1/moderations';

/** The categories OpenAI scores for images (see the list at the top). */
const IMAGE_CATEGORIES = ['sexual', 'violence', 'violence/graphic', 'self-harm', 'self-harm/intent', 'self-harm/instructions'];

// ----------------------------------------------------------------------------
// Policy settings: change these in the app settings, not in code
// ----------------------------------------------------------------------------

/**
 * Block threshold per category, from 0 to 1.
 * An image is blocked when its score is AT OR ABOVE the threshold.
 * LOWER number = STRICTER (more images blocked).
 *
 * Calibration from real tests (November 2026):
 *   safe test image       -> every score below 0.001   (allowed)
 *   knife attack photo    -> violence 0.834            (blocked)
 *   gore image            -> violence 0.767,
 *                            violence/graphic 0.717     (blocked)
 *
 * The three self-harm categories share one setting.
 */
const selfHarm = Number(env('OPENAI_THRESHOLD_SELF_HARM', 0.3));
const thresholds = {
  sexual: Number(env('OPENAI_THRESHOLD_SEXUAL', 0.3)), // strict, to keep out NSFW images
  violence: Number(env('OPENAI_THRESHOLD_VIOLENCE', 0.4)),
  'violence/graphic': Number(env('OPENAI_THRESHOLD_VIOLENCE_GRAPHIC', 0.3)),
  'self-harm': selfHarm,
  'self-harm/intent': selfHarm,
  'self-harm/instructions': selfHarm,
};

/**
 * Policy rule (b): also block anything OpenAI flags, even if it stayed
 * below our thresholds. On by default. Set OPENAI_BLOCK_ON_FLAGGED=false
 * to rely on the thresholds only.
 */
const blockOnFlagged = env('OPENAI_BLOCK_ON_FLAGGED', 'true') !== 'false';

// ----------------------------------------------------------------------------
// Step A: call the OpenAI Moderation API
// ----------------------------------------------------------------------------

/**
 * Send one image to OpenAI and return its moderation result.
 *
 * @param {Buffer} buffer    The image bytes.
 * @param {string} mimeType  The real image type, e.g. "image/png"
 *                           (from detectImageType, not from the client).
 * @param {object} opts
 * @param {string} opts.apiKey             OpenAI API key.
 * @param {number} [opts.timeoutMs=15000]  Give up if OpenAI takes longer than this.
 *
 * @returns {Promise<{flagged: boolean, categories: Record<string, boolean>, scores: Record<string, number>}>}
 *          flagged     OpenAI's own overall yes/no verdict
 *          categories  OpenAI's own yes/no verdict per category
 *          scores      score per image category, rounded to 4 decimals
 *
 * @throws {Error} If the call fails. The error carries:
 *                 .status  the HTTP status (400 bad image, 401 bad key,
 *                          429 rate limited, 5xx OpenAI problem)
 *                 .code    OpenAI's error code, if any
 */
async function analyzeImage (buffer, mimeType, { apiKey, timeoutMs = 15000 }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      // The image is sent inside the request as a "data URL"
      // (data:image/png;base64,....). It never has to be stored or made
      // public before it is checked.
      input: [{ type: 'image_url', image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` } }],
    }),
    // Stop waiting if OpenAI is slow, rather than hanging the upload.
    signal: AbortSignal.timeout(timeoutMs),
  });

  // Read the JSON body. On errors OpenAI sends { error: { message, code } }.
  // If the body isn't JSON at all (e.g. a proxy error page), use an empty object.
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(`OpenAI moderation error ${res.status}: ${body?.error?.message || res.statusText}`);
    err.status = res.status;
    err.code = body?.error?.code;
    throw err;
  }

  // We sent one input (the image), so there is exactly one result.
  const result = body.results?.[0];
  if (!result) {
    const err = new Error('OpenAI moderation returned no result');
    err.status = 502;
    throw err;
  }

  // Keep only the image categories, rounded to 4 decimals so they're
  // easy to read in logs, API responses and stored metadata.
  const scores = Object.fromEntries(
    IMAGE_CATEGORIES.map((c) => [c, Math.round((result.category_scores?.[c] ?? 0) * 10000) / 10000]),
  );

  return { flagged: Boolean(result.flagged), categories: result.categories || {}, scores };
}

// ----------------------------------------------------------------------------
// Step B: apply our policy to OpenAI's result
// ----------------------------------------------------------------------------

/**
 * Decide whether an image is allowed, based on OpenAI's result.
 *
 * @param {object}  analysis       The result of analyzeImage().
 * @param {object}  [limits]       Block thresholds per category (defaults to the settings above).
 * @param {boolean} [useFlagged]   Also block when OpenAI flags it (defaults to the setting above).
 *
 * @returns {{allowed: boolean, violations: Array<{category: string, score: number, threshold: number|string}>}}
 *          allowed     true if the image may be stored
 *          violations  each reason it was blocked, e.g.
 *                      { category: 'violence', score: 0.834, threshold: 0.4 }
 *                      threshold is "openai-flagged" when rule (b) caused the block
 */
function evaluate (analysis, limits = thresholds, useFlagged = blockOnFlagged) {
  // Rule (a): every category whose score reached our threshold.
  const violations = Object.entries(limits)
    .filter(([category, threshold]) => (analysis.scores[category] ?? 0) >= threshold)
    .map(([category, threshold]) => ({ category, score: analysis.scores[category], threshold }));

  // Rule (b): categories OpenAI flagged that rule (a) hasn't already listed.
  if (useFlagged && analysis.flagged) {
    for (const [category, isFlagged] of Object.entries(analysis.categories)) {
      if (isFlagged && !violations.some((v) => v.category === category)) {
        violations.push({ category, score: analysis.scores[category] ?? null, threshold: 'openai-flagged' });
      }
    }
  }

  return { allowed: violations.length === 0, violations };
}

// ----------------------------------------------------------------------------
// Entry point used by the upload function
// ----------------------------------------------------------------------------

/**
 * Check one image: call OpenAI (Step A), then apply our policy (Step B).
 *
 * @param {Buffer} buffer        The image bytes.
 * @param {string} mimeType      The detected image type, e.g. "image/png".
 * @returns {Promise<{allowed: boolean, violations: Array, scores: Record<string, number>}>}
 *          allowed     true = safe to store
 *          violations  why it was blocked (empty if allowed)
 *          scores      score per image category
 */
async function moderate (buffer, mimeType) {
  const analysis = await analyzeImage(buffer, mimeType, { apiKey: env('OPENAI_API_KEY') });
  return { ...evaluate(analysis), scores: analysis.scores };
}

module.exports = { moderate, analyzeImage, evaluate, thresholds };
