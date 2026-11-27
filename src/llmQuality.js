/**
 * ============================================================================
 *  AI image quality check (Azure OpenAI vision model)
 * ============================================================================
 *
 *  WHY THIS EXISTS
 *    The free local check (src/imageQuality.js) catches small and blurry
 *    images, but it can't see pixelation or images that were blown up from a
 *    tiny original (e.g. a 135 px logo stretched to 540 px still has sharp,
 *    blocky edges, so its blur score looks fine). A vision model can see these.
 *
 *  HOW IT WORKS
 *    1. The ORIGINAL image bytes are sent to an Azure OpenAI vision model
 *       deployment (e.g. gpt-5.4-mini). The image is never resized,
 *       cropped or re-encoded before it is sent, so the model judges exactly
 *       what the user uploaded.
 *    2. "detail: original" makes the model look at the image at its real
 *       resolution (it does not shrink it internally first).
 *    3. The model must answer in a fixed JSON format (structured output):
 *         { acceptable: true/false, problems: [...], reason: "..." }
 *       so the answer can be read reliably by code.
 *
 *  SETTINGS (Function App "Environment variables" / local.settings.json)
 *    QUALITY_AOAI_ENDPOINT      e.g. https://my-resource.openai.azure.com
 *                               (any form the portal shows works, see v1BaseUrl)
 *    QUALITY_AOAI_API_KEY       key of that Azure OpenAI resource
 *    QUALITY_AOAI_DEPLOYMENT    name of the vision model deployment (default gpt-5.4-mini)
 *
 *    The Azure OpenAI "v1" API is used, so no API version setting is needed.
 *
 *    Why not the usual AZURE_OPENAI_* names? Locally, `func start` never
 *    overrides a variable that already exists in the machine's environment.
 *    Developers often have AZURE_OPENAI_API_KEY set for other projects, which
 *    would silently replace this app's key. A unique prefix avoids that.
 *
 *  ERRORS
 *    Any error is thrown to the caller (src/functions/upload.js), which
 *    FAILS CLOSED: if this check can't run, the image is not stored.
 *    Errors keep the SDK's `.status` (HTTP code) and `.code` fields.
 *    Azure's own content filter can refuse to process an image; that error
 *    has code "content_filter" (see isContentFilterError below).
 *
 *  Package: "openai" on npm, the client Microsoft documents for Azure OpenAI
 *  in JavaScript (the older "@azure/openai" package is retired). For the v1
 *  API, Microsoft's docs use its standard OpenAI client pointed at the Azure
 *  address (baseURL). The AzureOpenAI class is for the older dated-version
 *  API: it adds "/openai/deployments/..." to the URL, which gives 404 on a
 *  "/openai/v1" endpoint.
 * ============================================================================
 */

const { OpenAI } = require('openai');

const env = (name, fallback) => process.env[name] || fallback;

/** The problems the model may report. Fixed list, so results are easy to count and filter. */
const PROBLEMS = ['blurry', 'pixelated', 'upscaled', 'compression_artifacts', 'noisy', 'bad_exposure'];

/**
 * Instructions to the model. It judges TECHNICAL quality only. Whether the
 * image is safe is decided separately by OpenAI moderation (src/moderation.js).
 */
//
// Tuned on 2026-11-26 against a labelled set of 12 images (clean photos and
// logos, plus copies made blocky by shrinking and enlarging 3x to 6x),
// 4 runs each. The earlier, looser prompt ("accept crisp logos", "if unsure,
// accept") passed the pixelated Ronin logo half the time; this one rejects
// it every time and still passes every clean image.
//
// Two things made the answers consistent:
//   1. Telling the model exactly what pixelation looks like (staircase steps
//      several pixels wide), and that normal anti-aliasing is fine.
//   2. Making it describe the edges ("edge_observation") BEFORE it decides.
//      The answer is written in schema order, so the verdict is based on
//      what it has just looked at.
const INSTRUCTIONS = `You inspect the technical quality of images uploaded to a website.
Judge ONLY technical quality. Ignore what the image shows, its subject, style and safety.

First, look closely at edges: curves, diagonal lines, text and outlines.
- A good image has smooth edges. Anti-aliased edges (a soft one-pixel transition) are normal and fine.
- A pixelated or upscaled image has edges made of visible square blocks or staircase steps, each step several pixels wide, or areas made of flat same-coloured squares. Even mild, regular stair-stepping counts.
Describe what you see in "edge_observation" before deciding.

Then reject the image (acceptable = false) if any of these is visible:
- pixelated: square pixel blocks or staircase edges, as described above
- upscaled: enlarged from a much smaller image (blocky, or soft and smeared detail everywhere)
- blurry: the main subject is out of focus or motion-blurred
- compression_artifacts: heavy JPEG blocking, ringing or colour banding
- noisy: heavy grain or noise that hides detail
- bad_exposure: so dark or so bright that the main subject's detail is lost

Accept intentional effects when the main subject is still sharp (for example a blurred background).
Accept flat graphics, logos and screenshots when their edges are smooth, not stepped.
List every problem you found in "problems" (empty if acceptable). Give a one-sentence "reason".`;

/**
 * JSON format the model must answer in (enforced by Azure OpenAI structured output).
 * Field order matters: "edge_observation" comes first so the model looks
 * before it decides.
 */
const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'image_quality',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['edge_observation', 'acceptable', 'problems', 'reason'],
      properties: {
        edge_observation: { type: 'string' },
        acceptable: { type: 'boolean' },
        problems: { type: 'array', items: { type: 'string', enum: PROBLEMS } },
        reason: { type: 'string' },
      },
    },
  },
};

/**
 * Azure OpenAI client. Created on first use and reused by later requests
 * (faster than reconnecting each time).
 */
let client;
function getClient () {
  if (!client) {
    const endpoint = env('QUALITY_AOAI_ENDPOINT');
    const apiKey = env('QUALITY_AOAI_API_KEY');
    if (!endpoint || !apiKey) {
      throw new Error('Azure OpenAI is not configured (set QUALITY_AOAI_ENDPOINT and QUALITY_AOAI_API_KEY)');
    }
    client = new OpenAI({
      baseURL: v1BaseUrl(endpoint),
      apiKey,
      timeout: 20000, // ms; give up on a hung call rather than keep the uploader waiting
      maxRetries: 1, // one retry on network errors / 429 / 5xx, then fail closed
    });
  }
  return client;
}

/**
 * Build the Azure OpenAI "v1" API address from whatever endpoint was configured.
 *
 * The Azure portal shows the endpoint in several forms, for example:
 *   https://my-resource.openai.azure.com
 *   https://my-resource.services.ai.azure.com/openai/v1
 *   https://my-resource.cognitiveservices.azure.com/
 * Only the host part matters, so we keep that and add "/openai/v1/".
 *
 * @param {string} endpoint  The configured endpoint URL.
 * @returns {string}         e.g. "https://my-resource.openai.azure.com/openai/v1/"
 */
function v1BaseUrl (endpoint) {
  return `${new URL(endpoint).origin}/openai/v1/`;
}

/**
 * Read the model's JSON answer and check it has the expected shape.
 * Throws if the answer is missing or malformed (the caller then fails closed).
 *
 * @param {string} content  The model's reply text (JSON).
 * @returns {{acceptable: boolean, problems: string[], reason: string}}
 */
function parseVerdict (content) {
  let data;
  try {
    data = JSON.parse(content);
  } catch {
    throw new Error('Quality model returned invalid JSON');
  }
  if (typeof data?.acceptable !== 'boolean' || !Array.isArray(data.problems)) {
    throw new Error('Quality model returned an unexpected answer');
  }
  return {
    acceptable: data.acceptable,
    problems: data.problems.filter((p) => PROBLEMS.includes(p)),
    reason: String(data.reason || ''),
  };
}

/** True if Azure's content filter refused to process the image (or the answer). */
const isContentFilterError = (err) => err?.code === 'content_filter';

/**
 * Ask the vision model whether the image's quality is good enough.
 *
 * @param {Buffer} buffer    The original image bytes (sent unchanged).
 * @param {string} mimeType  The real image type, e.g. "image/png".
 * @returns {Promise<{acceptable: boolean, problems: string[], reason: string, tokens?: number}>}
 */
async function judgeQuality (buffer, mimeType) {
  const completion = await getClient().chat.completions.create({
    model: env('QUALITY_AOAI_DEPLOYMENT', 'gpt-5.4-mini'), // on Azure, "model" is the DEPLOYMENT name
    temperature: 0, // same image, same answer as far as possible
    max_completion_tokens: 400, // the JSON answer is short; caps cost if the model rambles
                                // (newer models reject the older "max_tokens" name)
    response_format: RESPONSE_FORMAT,
    messages: [
      { role: 'system', content: INSTRUCTIONS },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Check this image.' },
          // detail "original": the model looks at the image at its real
          // resolution instead of shrinking it first, so small pixel steps
          // stay visible. Supported by the gpt-5.4 model family; older
          // models (e.g. gpt-4.1) only accept "low" / "high" / "auto".
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}`, detail: 'original' } },
        ],
      },
    ],
  });

  const choice = completion.choices?.[0];

  // Azure's content filter can also cut off the model's answer.
  if (choice?.finish_reason === 'content_filter') {
    const err = new Error('Azure OpenAI content filter blocked the response');
    err.code = 'content_filter';
    throw err;
  }

  return { ...parseVerdict(choice?.message?.content), tokens: completion.usage?.total_tokens };
}

module.exports = { judgeQuality, parseVerdict, isContentFilterError, PROBLEMS };
