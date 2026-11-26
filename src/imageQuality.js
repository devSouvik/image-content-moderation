/**
 * ============================================================================
 *  Image quality check: low resolution and blur
 * ============================================================================
 *
 *  Rejects images that are too small or too blurry to be useful.
 *
 *  1. RESOLUTION
 *     The image's width and height (in pixels) must both be at least the
 *     minimums below. A phone photo is typically 3000+ pixels wide; a
 *     thumbnail is often under 200.
 *
 *  2. BLUR ("sharpness score")
 *     Measured with a standard technique called "variance of the Laplacian":
 *       - The image is turned grey and scaled so its longer side is at most
 *         1024 px, so every image is judged at the same size.
 *       - The Laplacian is an edge detector: for each pixel it measures how
 *         different that pixel is from its four neighbours.
 *       - A SHARP image has crisp edges, so these differences vary a lot
 *         (high variance = high score).
 *       - A BLURRY image has soft edges, so the differences are all small
 *         (low variance = low score).
 *     The image is rejected if the score is below the blur threshold.
 *
 *  KNOWN LIMITATION
 *     Images with very little detail by design (a plain background, a simple
 *     logo, a flat illustration) also have few edges, so they score low and
 *     may be rejected as "blurry" even though they are perfectly sharp.
 *
 *  Image decoding uses the "sharp" library (built on libvips).
 * ============================================================================
 */

const sharp = require('sharp');

/** Read a setting by name (Azure app settings or local.settings.json). */
const env = (name, fallback) => process.env[name] ?? fallback;

// ----------------------------------------------------------------------------
// Quality settings: change these in the app settings, not in code
// ----------------------------------------------------------------------------

const limits = {
  /** Minimum width in pixels. */
  minWidth: Number(env('MIN_IMAGE_WIDTH', 300)),
  /** Minimum height in pixels. */
  minHeight: Number(env('MIN_IMAGE_HEIGHT', 300)),
  /**
   * Minimum sharpness score. Images scoring below this are "blurry".
   * HIGHER number = STRICTER (more images rejected as blurry).
   * See the README for the scores our test images got.
   */
  minSharpness: Number(env('MIN_SHARPNESS', 100)),
};

/** Images are scaled down to this size (longer side) before measuring blur. */
const ANALYSIS_SIZE = 1024;

// ----------------------------------------------------------------------------
// Blur measurement
// ----------------------------------------------------------------------------

/**
 * Variance of the Laplacian: the sharpness score.
 *
 * For every pixel (except the outer border) we compute:
 *   laplacian = top + bottom + left + right - 4 * centre
 * which is near 0 in smooth areas and large at sharp edges. The variance of
 * all these values is the score.
 *
 * @param {Uint8Array|Buffer} pixels  Greyscale pixels, one byte each, row by row.
 * @param {number} width
 * @param {number} height
 * @returns {number} Sharpness score (0 = completely flat; higher = sharper).
 */
function laplacianVariance (pixels, width, height) {
  let sum = 0;
  let sumOfSquares = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const laplacian = pixels[i - width] + pixels[i + width] + pixels[i - 1] + pixels[i + 1] - 4 * pixels[i];
      sum += laplacian;
      sumOfSquares += laplacian * laplacian;
      count++;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  return sumOfSquares / count - mean * mean; // variance = E[x²] - (E[x])²
}

// ----------------------------------------------------------------------------
// Step A: measure the image
// ----------------------------------------------------------------------------

/**
 * Decode the image and measure its size and sharpness.
 *
 * @param {Buffer} buffer  The image bytes.
 * @returns {Promise<{width: number, height: number, sharpness: number}>}
 *          width, height  as the image is displayed (phone photos rotated by
 *                         their EXIF orientation are measured upright)
 *          sharpness      the blur score, rounded to 1 decimal
 * @throws {Error} If the file can't be decoded (corrupt or truncated image).
 */
async function analyzeQuality (buffer) {
  const image = sharp(buffer).rotate(); // .rotate() with no angle = apply EXIF orientation

  const meta = await image.metadata();
  const width = meta.autoOrient?.width ?? meta.width;
  const height = meta.autoOrient?.height ?? meta.height;

  // Greyscale copy, scaled so the longer side is at most ANALYSIS_SIZE
  // (small images are not enlarged), as raw 1-byte-per-pixel data.
  const { data, info } = await image
    .greyscale()
    .resize(ANALYSIS_SIZE, ANALYSIS_SIZE, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const sharpness = Math.round(laplacianVariance(data, info.width, info.height) * 10) / 10;

  return { width, height, sharpness };
}

// ----------------------------------------------------------------------------
// Step B: apply the quality rules
// ----------------------------------------------------------------------------

/**
 * Decide whether the image's quality is acceptable.
 *
 * @param {{width: number, height: number, sharpness: number}} quality  The result of analyzeQuality().
 * @param {object} [rules]  Minimums to apply (defaults to the settings above).
 * @returns {{ok: boolean, problems: string[]}}
 *          ok        true if the image passes every rule
 *          problems  a readable reason for each failed rule
 */
function evaluateQuality (quality, rules = limits) {
  const problems = [];

  if (quality.width < rules.minWidth || quality.height < rules.minHeight) {
    problems.push(`Resolution too low: ${quality.width}x${quality.height} px (minimum ${rules.minWidth}x${rules.minHeight} px)`);
  }
  if (quality.sharpness < rules.minSharpness) {
    problems.push(`Image is too blurry: sharpness ${quality.sharpness} (minimum ${rules.minSharpness})`);
  }

  return { ok: problems.length === 0, problems };
}

// ----------------------------------------------------------------------------
// Entry point used by the upload function
// ----------------------------------------------------------------------------

/**
 * Measure the image (Step A) and apply the quality rules (Step B).
 * @param {Buffer} buffer  The image bytes.
 * @returns {Promise<{ok: boolean, problems: string[], quality: {width: number, height: number, sharpness: number}}>}
 */
async function checkQuality (buffer) {
  const quality = await analyzeQuality(buffer);
  return { ...evaluateQuality(quality), quality };
}

module.exports = { checkQuality, analyzeQuality, evaluateQuality, laplacianVariance, limits };
