/**
 * Shared constants for the Vision Helper MCP server.
 */

export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

/** Model used when neither the tool's `model` argument nor OPENROUTER_MODEL is set. */
export const DEFAULT_MODEL = "qwen/qwen3.8-max";

/**
 * Default fallback model, tried automatically when the primary model's provider
 * is busy or fails transiently (HTTP 429 / 5xx / timeout / network error).
 * Overridable via the OPENROUTER_FALLBACK_MODEL env variable.
 */
export const DEFAULT_FALLBACK_MODEL = "google/gemini-3.7-flash";

/**
 * Default model used when `quick: true` is passed to vision_helper_analyze_image.
 * Chosen for low latency and high throughput: cheap, fast, and image-capable
 * on OpenRouter. Overridable via the OPENROUTER_QUICK_MODEL env variable.
 */
export const DEFAULT_QUICK_MODEL = "meta/muse-glimmer-30b";

/** Default max output tokens for a quick analysis, to keep responses fast. */
export const QUICK_DEFAULT_MAX_TOKENS = 1024;

/**
 * Reasoning effort applied to quick analyses. The default quick model has
 * mandatory reasoning and supports efforts down to `low` (not `none`), so
 * `low` is the fastest setting that all reasoning models accept.
 */
export const QUICK_REASONING_EFFORT = "low";

/**
 * Reasoning effort applied to detailed analyses (vision_helper_analyze_image).
 * The default detailed model (qwen/qwen3.8-max) supports `high`, which the
 * OpenRouter reasoning guide notes yields more thorough reasoning and
 * better-quality answers than the model's default effort.
 */
export const DETAILED_REASONING_EFFORT = "high";

/**
 * Default max output tokens for a detailed analysis, used so long, thorough
 * answers (e.g. transcribing all visible text) are not cut off by a provider's
 * low default cap. Callers can still override via max_tokens (schema caps at 16000).
 */
export const DETAILED_DEFAULT_MAX_TOKENS = 8192;

/** Default prompt for quick analysis — concise answer, not a full description. */
export const DEFAULT_QUICK_PROMPT =
  "Briefly describe what is in the provided image(s) in a few short sentences. " +
  "Note any readable text. Be concise.";

/** Default maximum image payload size in bytes (10 MB). */
export const DEFAULT_MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/** Hard ceiling for the configured max image size (50 MB). */
export const ABSOLUTE_MAX_IMAGE_SIZE = 50 * 1024 * 1024;

/** Maximum number of images accepted in a single analysis call. */
export const MAX_IMAGE_COUNT = 5;

/** Aggregate cap across all images in one request (avoids huge JSON payloads). */
export const MAX_TOTAL_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * Stdio buffer size for incoming JSON-RPC messages. Must be large enough for
 * base64 images up to the aggregate cap (~34 MB of JSON at 25 MB of images),
 * exceeding the SDK's 10 MB default which would silently drop larger calls.
 */
export const STDIO_MAX_BUFFER_SIZE = 64 * 1024 * 1024;

/**
 * Image content types OpenRouter accepts for vision models
 * (https://openrouter.ai/docs/guides/overview/multimodal/image-understanding).
 */
export const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Human-readable list for error messages. */
export const SUPPORTED_FORMATS = "PNG, JPEG, WebP, or GIF";

/** Timeout for a single OpenRouter chat completion request. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** Timeout for downloading an image from a remote URL. */
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

/** Timeout for the OpenRouter models list request. */
export const MODELS_LIST_TIMEOUT_MS = 30_000;

/** How long the fetched model catalog is kept in memory. */
export const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;

/** Hard cap on response text returned to the calling model (characters). */
export const CHARACTER_LIMIT = 25_000;

/** Default prompt used when the caller does not supply one. */
export const DEFAULT_ANALYSIS_PROMPT =
  "Describe this image in detail. Include all visible text, objects, people, " +
  "colors, layout, and any other notable details. If there is readable text, " +
  "transcribe it verbatim.";
