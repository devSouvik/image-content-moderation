/**
 * ============================================================================
 *  Upload endpoint: POST /api/upload
 * ============================================================================
 *
 *  WHAT IT DOES
 *    Accepts one image, checks it with the OpenAI Moderation API, and saves
 *    it to Azure Blob Storage ONLY if the image is safe. Unsafe images are
 *    rejected and never saved.
 *
 *  STEPS (each step can stop the request early)
 *
 *    Step 1  Read the image from the request ............ 400 if missing
 *    Step 2  Check the file size (max 15 MB) ............ 413 if too large
 *    Step 3  Check the file is a real, supported image .. 415 if not
 *    Step 4  Check quality: resolution and blur ......... 422 if too small/blurry
 *    Step 5  Ask OpenAI moderation if it is safe ........ 422 if unsafe
 *                                                         502 if the service fails
 *    Step 6  Save the image to Blob Storage ............. 201 on success
 *
 *  SAFETY RULE: "FAIL CLOSED"
 *    If the moderation service can't be reached or returns an error, the
 *    image is NOT saved. We never store an image that hasn't been checked.
 * ============================================================================
 */

const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const { randomUUID } = require('node:crypto');
const { detectImageType, SUPPORTED_FORMATS } = require('../imageType');
const { checkQuality } = require('../imageQuality');
const { moderate } = require('../moderation');

// ----------------------------------------------------------------------------
// Settings and shared objects (created once, when the function app starts)
// ----------------------------------------------------------------------------

/**
 * Read a setting by name.
 * In Azure, settings come from the Function App's "Environment variables".
 * Locally, they come from local.settings.json. Both appear as process.env.
 */
const env = (name, fallback) => process.env[name] ?? fallback;

/**
 * Largest upload this API accepts: a fixed 15 MB.
 * (OpenAI itself accepts up to 20 MB, so 15 MB is always within its limit.)
 */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * Connection to the Blob Storage container where safe images are saved.
 * Created on first use and then reused by every later request, which is
 * faster than reconnecting each time.
 */
let containerClient;
function getContainer () {
  if (!containerClient) {
    containerClient = BlobServiceClient
      .fromConnectionString(env('IMAGES_STORAGE_CONNECTION'))
      .getContainerClient(env('IMAGES_CONTAINER', 'images'));
  }
  return containerClient;
}

/** Build a JSON HTTP response: reply(404, { error: '...' }). */
const reply = (status, jsonBody) => ({ status, jsonBody });

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Pull the uploaded image out of the request.
 *
 * Two ways of sending an image are supported:
 *   1. Form upload (multipart/form-data) with the image in a field named "file".
 *      This is what Postman's "form-data" body and `curl -F "file=@photo.jpg"` send.
 *   2. The raw image bytes as the whole request body.
 *      Example: `curl --data-binary @photo.jpg "...?filename=photo.jpg"`
 *
 * @returns {Promise<{buffer?: Buffer, originalName?: string, error?: string}>}
 *          The image bytes and original file name, or an error message.
 */
async function readImage (request) {
  const contentType = request.headers.get('content-type') || '';

  // Option 1: form upload
  if (contentType.startsWith('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file');

    // A text field (string) or a missing field is not a file upload.
    if (!file || typeof file === 'string') return { error: 'Form field "file" is required' };

    return { buffer: Buffer.from(await file.arrayBuffer()), originalName: file.name };
  }

  // Option 2: raw body
  return { buffer: Buffer.from(await request.arrayBuffer()), originalName: request.query.get('filename') };
}

// ----------------------------------------------------------------------------
// The HTTP endpoint
// ----------------------------------------------------------------------------

app.http('upload', {
  methods: ['POST'],
  route: 'upload', // full path: /api/upload

  // Callers must send the function key in the "x-functions-key" header
  // (or as ?code=...). Running locally with `func start`, no key is needed.
  authLevel: 'function',

  handler: async (request, context) => {
    // ------------------------------------------------------------------------
    // Quick pre-check: reject obviously oversized uploads before reading them.
    // The Content-Length header is only a claim by the client, so the real
    // size is checked again in Step 2. The extra 64 KB allows for the form
    // wrapping that multipart uploads add around the file.
    // ------------------------------------------------------------------------
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (declaredLength > MAX_UPLOAD_BYTES + 64 * 1024) {
      return reply(413, { error: 'Image exceeds 15 MB limit' });
    }

    // ------------------------------------------------------------------------
    // Step 1: Read the image from the request
    // ------------------------------------------------------------------------
    let image;
    try {
      image = await readImage(request);
    } catch (err) {
      // For example, a malformed multipart body.
      return reply(400, { error: `Could not read request body: ${err.message}` });
    }
    if (image.error) return reply(400, { error: image.error });

    const { buffer, originalName } = image;

    // ------------------------------------------------------------------------
    // Step 2: Check the real file size
    // ------------------------------------------------------------------------
    if (!buffer.length) return reply(400, { error: 'Empty body' });
    if (buffer.length > MAX_UPLOAD_BYTES) {
      return reply(413, { error: 'Image exceeds 15 MB limit' });
    }

    // ------------------------------------------------------------------------
    // Step 3: Check it's a real image in a supported format
    //
    // We look at the file's actual bytes, not its name or the Content-Type the
    // client sent, because both can be faked. (Example: an AVIF image renamed
    // to "photo.jpeg" is caught here.)
    // ------------------------------------------------------------------------
    const kind = detectImageType(buffer);
    if (!kind) {
      return reply(415, { error: `Unsupported file. Allowed: ${SUPPORTED_FORMATS}` });
    }

    // ------------------------------------------------------------------------
    // Step 4: Check image quality (resolution and blur)
    //
    // Runs before moderation, so low-quality images are rejected quickly
    // without calling OpenAI. Rules and thresholds: see src/imageQuality.js.
    // ------------------------------------------------------------------------
    let qualityCheck; // { ok: true/false, problems: [...], quality: { width, height, sharpness } }
    try {
      qualityCheck = await checkQuality(buffer);
    } catch (err) {
      // The bytes look like an image but can't be decoded (corrupt or truncated file).
      return reply(422, { error: 'Image could not be decoded', detail: err.message });
    }

    if (!qualityCheck.ok) {
      context.warn(`Rejected low-quality upload (${originalName || 'unnamed'}): ${qualityCheck.problems.join('; ')}`);
      return reply(422, {
        error: 'Image quality too low',
        problems: qualityCheck.problems,
        quality: qualityCheck.quality,
      });
    }

    // ------------------------------------------------------------------------
    // Step 5: Ask OpenAI moderation whether the image is safe
    // ------------------------------------------------------------------------
    let verdict; // { allowed: true/false, violations: [...], scores: {...} }
    try {
      verdict = await moderate(buffer, kind.type);
    } catch (err) {
      context.error('Moderation call failed', err);

      // HTTP 400 from OpenAI means the image itself was invalid
      // (corrupt, animated GIF, etc.), so we tell the caller it was rejected.
      if (err.status === 400) {
        return reply(422, { error: 'Image rejected by moderation service validation', detail: err.message });
      }

      // Anything else is a problem on our side: wrong key, rate limit (429),
      // service outage (5xx) or timeout. FAIL CLOSED: do not save the image.
      return reply(502, { error: 'Content moderation unavailable; image not stored' });
    }

    if (!verdict.allowed) {
      // Record every blocked upload in the logs for auditing.
      context.warn(`Blocked upload (${originalName || 'unnamed'}): ${JSON.stringify(verdict.violations)}`);

      // 422 = "we understood the request, but we won't accept this content".
      // The response says which categories caused the block, and all scores.
      return reply(422, {
        error: 'Image blocked by content policy',
        violations: verdict.violations,
        scores: verdict.scores,
      });
    }

    // ------------------------------------------------------------------------
    // Step 6: The image is good quality and safe, so save it to Blob Storage
    //
    // File name in storage: <date>/<random id><extension>
    //   e.g. "2026-11-26/b66bd712-aa83-4dc7-9c72-3cb07904c818.png"
    //   - The date folder groups uploads by day.
    //   - The random id means two uploads can never overwrite each other, and
    //     the user's own file name (which could contain odd characters) is
    //     never used as a storage path.
    // ------------------------------------------------------------------------
    const blobName = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}${kind.ext}`;
    const blob = getContainer().getBlockBlobClient(blobName);

    await blob.uploadData(buffer, {
      // The real image type, so browsers display the file correctly.
      blobHTTPHeaders: { blobContentType: kind.type },

      // Extra information saved alongside the image, for auditing.
      // Metadata values must be plain ASCII, so the original name is URL-encoded.
      metadata: {
        originalname: encodeURIComponent(originalName || ''),
        quality: `${qualityCheck.quality.width}x${qualityCheck.quality.height},sharpness:${qualityCheck.quality.sharpness}`, // e.g. "1200x822,sharpness:416.7"
        moderation:Object.entries(verdict.scores).map(([k, v]) => `${k}:${v}`).join(','), // e.g. "sexual:0.0001,violence:0.0005,..."
      },
    });

    context.log(`Stored ${blobName} (${buffer.length} bytes)`);

    // 201 = created. Note: the returned URL is private (public access is turned
    // off on the storage account). Reading it needs a SAS token or Azure login.
    return reply(201, {
      blobName,
      url: blob.url,
      contentType: kind.type,
      size: buffer.length,
      quality: qualityCheck.quality,
      scores: verdict.scores,
    });
  },
});
