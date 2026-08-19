/**
 * OpenRouter API client for the Vision Helper MCP server.
 *
 * Uses Node's built-in fetch (Node >= 18). Chat completions are retried on
 * transient failures (429, 5xx, network errors) with backoff; HTTP 4xx errors
 * are surfaced immediately with actionable messages.
 */

import {
  DETAILED_DEFAULT_MAX_TOKENS,
  DETAILED_REASONING_EFFORT,
  MODELS_CACHE_TTL_MS,
  MODELS_LIST_TIMEOUT_MS,
  OPENROUTER_API_BASE,
  QUICK_DEFAULT_MAX_TOKENS,
  QUICK_REASONING_EFFORT,
} from "../constants.js";
import { LoadedImage } from "./images.js";

/** Error carrying an HTTP status from OpenRouter plus the raw response body. */
export class VisionApiError extends Error {
  readonly status: number;
  readonly rawBody: string;

  constructor(status: number, message: string, rawBody = "") {
    super(message);
    this.name = "VisionApiError";
    this.status = status;
    this.rawBody = rawBody;
  }
}

export interface AnalyzeImageOptions {
  apiKey: string;
  model: string;
  images: LoadedImage[];
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs: number;
  /**
   * When true, apply speed-optimized defaults for a quick analysis:
   * a low output-token cap and minimal reasoning effort. Callers can still
   * override maxTokens; the reasoning effort is fixed to the fastest
   * setting that reasoning models accept.
   */
  quick?: boolean;
  /**
   * When true, optimize for a detailed, thorough analysis: a higher reasoning
   * effort and a higher default output-token cap than the provider default.
   * Mutually exclusive with `quick`. Callers can still override maxTokens.
   */
  detailed?: boolean;
  /**
   * Alternate model to try automatically if the primary model's provider is
   * busy or a request fails transiently (429 / 5xx / timeout / network error).
   * When unset (or identical to `model`), no fallback is attempted.
   */
  fallbackModel?: string;
}

export interface AnalyzeImageResult {
  /** The model's text reply. */
  text: string;
  /** The model that actually produced the reply (primary or fallback). */
  model: string;
  /** True when the primary model failed and the fallback reply was used. */
  fallbackUsed: boolean;
}

export interface OpenRouterModelInfo {
  id: string;
  name: string;
  contextLength: number;
  promptPricePerM: number;
  description: string;
}

interface OpenRouterChatResponse {
  choices?: Array<{
    message?: { content?: unknown };
  }>;
}

interface OpenRouterModelsResponse {
  data?: unknown;
}

interface ModelRaw {
  id?: string;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
  pricing?: { prompt?: string };
}

interface ModelsCacheEntry {
  key: string;
  at: number;
  models: OpenRouterModelInfo[];
}

let modelsCache: ModelsCacheEntry | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cap on how long a `Retry-After` header may delay a retry. */
const MAX_RETRY_AFTER_MS = 15_000;

/** Network-level failure markers that are worth retrying. */
const NETWORK_ERROR_RE = /fetch failed|ECONNRESET|ENOTFOUND|getaddrinfo/i;

/** Backoff delay before a retry, honoring a capped `Retry-After` header. */
function retryDelayMs(response: Response, attempt: number): number {
  const rawRetryAfterMs = Number(response.headers.get("retry-after") ?? "0") * 1000;
  const retryAfterMs = Number.isFinite(rawRetryAfterMs) && rawRetryAfterMs > 0 ? rawRetryAfterMs : 0;
  const baseMs = attempt === 1 ? 1_500 : 3_000;
  return Math.min(Math.max(retryAfterMs, baseMs), MAX_RETRY_AFTER_MS);
}

/** Extract the model's text reply from a chat completion response. Exported for unit tests. */
export function extractContentText(data: OpenRouterChatResponse): string {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : "(empty response)";
  }
  if (Array.isArray(content)) {
    const parts = content
      .filter(
        (part): part is { type: string; text?: unknown } =>
          typeof part === "object" && part !== null && "type" in part
      )
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string);
    if (parts.length > 0) return parts.join("\n").trim();
  }
  return "(empty response)";
}

/** Extract a short diagnostic hint from an OpenRouter error body. */
function extractErrorHint(rawBody: string): string {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (typeof parsed === "object" && parsed !== null) {
      const err = (parsed as { error?: { message?: unknown } }).error;
      if (err && typeof err.message === "string" && err.message.length > 0) {
        const message = err.message.slice(0, 300);
        return message;
      }
    }
  } catch {
    /* not JSON; ignore */
  }
  return "";
}

/** Build the chat completion body for the given model. */
function buildChatBody(options: AnalyzeImageOptions, model: string): Record<string, unknown> {
  const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    { type: "text", text: options.prompt },
    ...options.images.map((image) => ({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
    })),
  ];

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content }],
  };
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.quick === true) {
    if (body.max_tokens === undefined) body.max_tokens = QUICK_DEFAULT_MAX_TOKENS;
    body.reasoning = { effort: QUICK_REASONING_EFFORT };
  } else if (options.detailed === true) {
    if (body.max_tokens === undefined) body.max_tokens = DETAILED_DEFAULT_MAX_TOKENS;
    body.reasoning = { effort: DETAILED_REASONING_EFFORT };
  }
  return body;
}

/**
 * Send the images plus prompt to the given model and return its text reply.
 * Retries up to 3 attempts on 429 / 5xx / network failures.
 */
async function requestChatCompletion(options: AnalyzeImageOptions, model: string): Promise<string> {
  const body = buildChatBody(options, model);
  const attempts = 3;
  let lastError: unknown = new Error("Unknown error calling OpenRouter.");

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/quickstraw/vision-helper-mcp-server",
          "X-OpenRouter-Title": "Vision Helper MCP",
          "User-Agent": "Vision-Helper-MCP/1.0",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs),
      });

      if (response.ok) {
        let data: OpenRouterChatResponse;
        try {
          data = (await response.json()) as OpenRouterChatResponse;
        } catch {
          // A 2xx body that is not JSON will not fix itself — fail immediately.
          throw new VisionApiError(0, "OpenRouter returned a malformed (non-JSON) response body.", "");
        }
        return extractContentText(data);
      }

      const status = response.status;
      const rawBody = await response.text();
      if (status === 429 || status >= 500) {
        lastError = new VisionApiError(status, `OpenRouter returned HTTP ${status}.`, rawBody);
        if (attempt < attempts) await sleep(retryDelayMs(response, attempt));
        continue;
      }
      throw new VisionApiError(status, `OpenRouter returned HTTP ${status}.`, rawBody);
    } catch (error) {
      if (error instanceof VisionApiError) throw error;
      lastError = error;
      if (attempt < attempts) await sleep(attempt === 1 ? 1_500 : 3_000);
    }
  }

  throw lastError;
}

/** True when the error looks like a busy/unavailable provider that a fallback could avoid. */
function isFallbackEligible(error: unknown): boolean {
  if (error instanceof VisionApiError) return error.status === 429 || error.status >= 500;
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return true;
    if (NETWORK_ERROR_RE.test(error.message)) return true;
  }
  return false;
}

/** Short, human-readable reason for an error, used in combined fallback failures. */
function describeErrorBrief(error: unknown): string {
  if (error instanceof VisionApiError) return `HTTP ${error.status}`;
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "timeout";
    if (NETWORK_ERROR_RE.test(error.message)) return "network error";
    return error.message;
  }
  return String(error);
}

/**
 * Analyze the images with the primary model, then with the fallback model if
 * the primary's provider is busy or fails transiently. Returns the reply plus
 * the model that produced it.
 */
export async function analyzeImage(options: AnalyzeImageOptions): Promise<AnalyzeImageResult> {
  try {
    const text = await requestChatCompletion(options, options.model);
    return { text, model: options.model, fallbackUsed: false };
  } catch (primaryError) {
    const fallbackModel = options.fallbackModel?.trim();
    if (
      fallbackModel !== undefined &&
      fallbackModel.length > 0 &&
      fallbackModel !== options.model &&
      isFallbackEligible(primaryError)
    ) {
      try {
        const text = await requestChatCompletion(options, fallbackModel);
        return { text, model: fallbackModel, fallbackUsed: true };
      } catch (fallbackError) {
        throw new Error(
          `Analysis failed on both the primary model '${options.model}' and the fallback model '${fallbackModel}'. ` +
            `Primary: ${describeErrorBrief(primaryError)}. Fallback: ${describeErrorBrief(fallbackError)}.`
        );
      }
    }
    throw primaryError;
  }
}

/**
 * Fetch the OpenRouter model catalog and keep only models that accept image
 * input. Falls back to keyword matching if the catalog schema ever lacks
 * modality fields. Results are cached in-process for MODELS_CACHE_TTL_MS.
 */
export async function listVisionModels(
  apiKey: string
): Promise<OpenRouterModelInfo[]> {
  if (modelsCache !== null && modelsCache.key === apiKey) {
    const { models, at } = modelsCache;
    if (Date.now() - at < MODELS_CACHE_TTL_MS) return models;
  }

  const response = await fetch(`${OPENROUTER_API_BASE}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "Vision-Helper-MCP/1.0",
    },
    signal: AbortSignal.timeout(MODELS_LIST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const rawBody = await response.text();
    throw new VisionApiError(response.status, `Failed to fetch model list (HTTP ${response.status}).`, rawBody);
  }

  const parsed = (await response.json()) as OpenRouterModelsResponse;
  const rawModels: ModelRaw[] = Array.isArray(parsed.data) ? (parsed.data as ModelRaw[]) : [];

  const hasImageModality = (m: ModelRaw): boolean =>
    Array.isArray(m.architecture?.input_modalities) &&
    m.architecture!.input_modalities!.includes("image");

  const hasVisionKeywords = (m: ModelRaw): boolean =>
    typeof m.description === "string" && /vision|multimodal/i.test(m.description);

  let visionModels = rawModels.filter(hasImageModality);
  if (visionModels.length === 0) {
    visionModels = rawModels.filter(hasVisionKeywords);
  }

  const result = visionModels
    .filter((m) => typeof m.id === "string" && m.id.length > 0)
    .map((m) => ({
      id: m.id!,
      name: typeof m.name === "string" && m.name.length > 0 ? m.name : m.id!,
      contextLength: typeof m.context_length === "number" ? m.context_length : 0,
      promptPricePerM:
        typeof m.pricing?.prompt === "string"
          ? Math.round(Number.parseFloat(m.pricing.prompt) * 1_000_000 * 100) / 100
          : 0,
      description: typeof m.description === "string" ? m.description : "",
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  modelsCache = { key: apiKey, at: Date.now(), models: result };
  return result;
}

/** Convert any thrown error into a clear, actionable message for the model. */
export function describeApiError(error: unknown): string {
  if (error instanceof VisionApiError) {
    const hint = extractErrorHint(error.rawBody);
    switch (error.status) {
      case 401:
        return (
          "Error: OpenRouter rejected the API key (HTTP 401). Check that OPENROUTER_API_KEY is " +
          "correct and starts with 'sk-or-v1-'. Run vision_helper_check_config to see where the key was loaded from."
        );
      case 402:
        return "Error: Insufficient OpenRouter credits (HTTP 402). Add credits at https://openrouter.ai/settings/credits and retry.";
      case 404:
        return (
          `Error: Model not found on OpenRouter (HTTP 404). ${hint ? `Details: ${hint}. ` : ""}` +
          "Run vision_helper_list_models to see available vision models, then pass a valid one via the 'model' argument."
        );
      case 429:
        return (
          "Error: OpenRouter rate limit or quota exceeded (HTTP 429). Wait a moment and retry, " +
          "or reduce max_tokens / image sizes."
        );
      case 400:
        return (
          `Error: The request was rejected by OpenRouter (HTTP 400). ${hint ? `Details: ${hint}` : ""}` +
          " Check that the image is a supported format and the model supports image input."
        );
      case 0:
        return "Error: OpenRouter returned a malformed (non-JSON) response. Try again, or use a different model.";
      default:
        return `Error: OpenRouter request failed with HTTP ${error.status}. ${hint ? `Details: ${hint}` : ""} Retry with a different model if this persists.`;
    }
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return "Error: The vision model request timed out. Try again, use a faster model, or reduce the number of images.";
  }
  if (error instanceof Error && error.message) {
    const message = error.message;
    if (NETWORK_ERROR_RE.test(message)) {
      return "Error: Could not reach OpenRouter (network error). Check your internet connection and retry.";
    }
    return `Error: ${message}`;
  }
  return `Error: Unexpected failure: ${String(error)}`;
}
