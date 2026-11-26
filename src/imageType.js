/**
 * ============================================================================
 *  Image type detection
 * ============================================================================
 *
 *  Works out what kind of image a file REALLY is by reading its first few
 *  bytes. Every image format starts with a fixed pattern of bytes (often
 *  called a "magic number" or "file signature").
 *
 *  Only the formats the OpenAI Moderation API accepts are recognised:
 *  JPEG, PNG, GIF and WEBP. Anything else (BMP, TIFF, AVIF, HEIC, PDFs,
 *  text files...) is treated as unsupported.
 *
 *  Why not just trust the file name or Content-Type header?
 *    The client controls both and can get them wrong or fake them.
 *    Real example from testing: an AVIF image saved as "violence.jpeg".
 *    Its name says JPEG, but its bytes say AVIF, so it is rejected here.
 * ============================================================================
 */

/**
 * Supported image formats.
 *   type  The real MIME type. Sent to OpenAI and saved as the stored file's Content-Type.
 *   ext   File extension used when naming the stored file.
 *   test  Returns true if the bytes match this format's signature.
 */
const SIGNATURES = [
  // JPEG: always starts with the bytes FF D8 FF
  { type: 'image/jpeg', ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },

  // PNG: always starts with the same 8 bytes: 89 50 4E 47 0D 0A 1A 0A (".PNG....")
  { type: 'image/png', ext: '.png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },

  // GIF: starts with the text "GIF87a" or "GIF89a" (checking "GIF8" covers both)
  { type: 'image/gif', ext: '.gif', test: (b) => b.subarray(0, 4).toString('ascii') === 'GIF8' },

  // WEBP: the text "RIFF", then 4 bytes giving the file size, then the text "WEBP"
  { type: 'image/webp', ext: '.webp', test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
];

/** Human-readable list of supported formats, for error messages: "JPEG, PNG, GIF, WEBP". */
const SUPPORTED_FORMATS = SIGNATURES.map((s) => s.type.replace('image/', '').toUpperCase()).join(', ');

/**
 * Identify an image's real format from its bytes.
 *
 * @param {Buffer} buffer  The uploaded file.
 * @returns {{type: string, ext: string} | null}
 *          The matching format, e.g. { type: 'image/png', ext: '.png' },
 *          or null if the file is not a supported image.
 */
function detectImageType (buffer) {
  // The longest signature check (WEBP) needs the first 12 bytes.
  // Anything shorter cannot be a valid image.
  if (!buffer || buffer.length < 12) return null;

  return SIGNATURES.find((format) => format.test(buffer)) || null;
}

module.exports = { detectImageType, SUPPORTED_FORMATS };
