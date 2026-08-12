/**
 * OpenRouter API client for the Vision Helper MCP server.
 *
 * Uses Node's built-in fetch (Node >= 18). Chat completions are retried on
 * transient failures (429, 5xx, network errors) with backoff; HTTP 4xx errors
 * are surfaced immediately with actionable messages.
 */

import { MODELS_CACHE_TTL_MS, MODELS_LIST_TIMEOUT_MS, OPENROUTER_API_BASE } from "../constants.js";
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

function extractContentText(data: OpenRouterChatResponse): string {
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

/**
 * Send the images plus prompt to the vision model and return its text reply.
 * Retries up to 3 attempts on 429 / 5xx / network failures.
 */
export async function analyzeImage(options: AnalyzeImageOptions): Promise<string> {
  const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    { type: "text", text: options.prompt },
    ...options.images.map((image) => ({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
    })),
  ];

  const body: Record<string, unknown> = {
    model: options.model,
    messages: [{ role: "user", content }],
  };
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;

  const attempts = 3;
  let lastError: unknown = new Error("Unknown error calling OpenRouter.");

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/vision-helper-mcp",
          "X-OpenRouter-Title": "Vision Helper MCP",
          "User-Agent": "Vision-Helper-MCP/1.0",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs),
      });

      if (response.ok) {
        const data = (await response.json()) as OpenRouterChatResponse;
        return extractContentText(data);
      }

      const status = response.status;
      const rawBody = await response.text();
      if (status === 429 || status >= 500) {
        lastError = new VisionApiError(status, `OpenRouter returned HTTP ${status}.`, rawBody);
        const retryAfterMs = Number(response.headers.get("retry-after") ?? "0") * 1000;
        await sleep(Math.max(retryAfterMs, attempt === 1 ? 1_500 : 3_000));
        continue;
      }
      throw new VisionApiError(status, `OpenRouter returned HTTP ${status}.`, rawBody);
    } catch (error) {
      if (error instanceof VisionApiError) throw error;
      lastError = error;
      await sleep(attempt === 1 ? 1_500 : 3_000);
    }
  }

  throw lastError;
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
      default:
        return `Error: OpenRouter request failed with HTTP ${error.status}. ${hint ? `Details: ${hint}` : ""} Retry with a different model if this persists.`;
    }
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return "Error: The vision model request timed out. Try again, use a faster model, or reduce the number of images.";
  }
  if (error instanceof Error && error.message) {
    const message = error.message;
    if (/fetch failed|ECONNRESET|ENOTFOUND|getaddrinfo/i.test(message)) {
      return "Error: Could not reach OpenRouter (network error). Check your internet connection and retry.";
    }
    return `Error: ${message}`;
  }
  return `Error: Unexpected failure: ${String(error)}`;
}
