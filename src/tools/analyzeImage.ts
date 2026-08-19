/** vision_helper_analyze_image tool: send one or more images to an OpenRouter vision model. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import {
  CHARACTER_LIMIT,
  DEFAULT_ANALYSIS_PROMPT,
  DEFAULT_FALLBACK_MODEL,
  DEFAULT_MODEL,
  DEFAULT_QUICK_MODEL,
  DEFAULT_QUICK_PROMPT,
  MAX_IMAGE_COUNT,
  MAX_TOTAL_IMAGE_BYTES,
  QUICK_DEFAULT_MAX_TOKENS,
  SUPPORTED_FORMATS,
} from "../constants.js";
import {
  getApiKey,
  getEffectiveDefaultModel,
  getEffectiveFallbackModel,
  getEffectiveQuickModel,
  getMaxImageSize,
  getRequestTimeoutMs,
} from "../config.js";
import { loadImage } from "../services/images.js";
import { analyzeImage, describeApiError } from "../services/openrouter.js";
import { errorResult, missingApiKeyResult, textResult, truncateToLimit } from "../services/results.js";
import { AnalyzeImageSchema } from "../schemas.js";

type AnalyzeImageParams = z.infer<typeof AnalyzeImageSchema>;

export function registerAnalyzeImageTool(server: McpServer): void {
  server.registerTool(
    "vision_helper_analyze_image",
    {
      title: "Analyze Image with a Vision Model (Vision Helper)",
      description: `Analyze one or more images using a vision-capable model from OpenRouter, returning the model's analysis as text. Use this whenever you need to know what is in an image but you cannot see images yourself.

Default mode is **detailed analysis**: use it for thorough understanding — transcribe all readable text, describe objects/people/colors/layout, reason about ambiguous or complex content, or compare several images (pass an array, up to ${MAX_IMAGE_COUNT}). It requests high reasoning effort and a higher token budget, and uses a high-quality model by default ('${DEFAULT_MODEL}').

Pass **quick: true** for a fast, cheap analysis of a single image — a yes/no, a short caption, or an object/color check. Quick mode uses the quick model ('${DEFAULT_QUICK_MODEL}'), caps output at ${QUICK_DEFAULT_MAX_TOKENS} tokens, and forces minimal reasoning.

Accepts an http(s) URL, local file path, file:// URI, data: URI, or raw base64. Only ${SUPPORTED_FORMATS} are accepted (per OpenRouter); remote URLs are validated against private/internal hosts before fetching. Relative file paths resolve against the server's working directory — prefer absolute paths or URLs. If the model's provider is busy or fails transiently (429/5xx/timeout/network), the request is retried, then falls back to the fallback model ('${DEFAULT_FALLBACK_MODEL}') automatically (detailed mode).

The response is prefixed with the model and image sources used; long analyses are truncated at ${CHARACTER_LIMIT} characters. Errors carry actionable guidance (missing key, invalid model, oversized image, unsupported format).`,
      inputSchema: AnalyzeImageSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: AnalyzeImageParams) => {
      try {
        const quick = params.quick === true;
        const keyInfo = await getApiKey();
        if (keyInfo === null) {
          return missingApiKeyResult();
        }

        const sources = Array.isArray(params.image) ? params.image : [params.image];
        if (quick && sources.length > 1) {
          return errorResult(
            "Error: quick mode accepts exactly one image. Omit 'quick' (or set it to false) " +
              "to analyze multiple images together."
          );
        }

        const model = params.model?.trim() || (await (quick ? getEffectiveQuickModel() : getEffectiveDefaultModel()));
        const fallbackModel = (await getEffectiveFallbackModel()).trim();
        const maxImageSize = await getMaxImageSize();
        const timeoutMs = await getRequestTimeoutMs();

        const images = await Promise.all(
          sources.map((source) => loadImage(source, maxImageSize))
        );

        const totalBytes = images.reduce((sum, img) => sum + img.byteLength, 0);
        if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
          return errorResult(
            `Error: The ${images.length} images total ${totalBytes} bytes, exceeding the aggregate ` +
              `limit of ${MAX_TOTAL_IMAGE_BYTES} bytes (${Math.round(MAX_TOTAL_IMAGE_BYTES / 1024 / 1024)} MB) per request. ` +
              `Analyze fewer or smaller images, or split the request.`
          );
        }

        const prompt = params.prompt?.trim() || (quick ? DEFAULT_QUICK_PROMPT : DEFAULT_ANALYSIS_PROMPT);
        const analysis = await analyzeImage({
          apiKey: keyInfo.value,
          model,
          quick,
          detailed: !quick,
          fallbackModel: !quick && fallbackModel.length > 0 ? fallbackModel : undefined,
          images,
          prompt,
          maxTokens: params.max_tokens,
          temperature: params.temperature,
          timeoutMs,
        });

        const imageList = images.map((img) => `- ${img.sourceLabel} (${img.mimeType}, ${img.byteLength} bytes)`);
        const fallbackNote = analysis.fallbackUsed ? ` (primary '${model}' unavailable — used fallback)` : "";
        const label = quick ? "Quick vision analysis" : "Vision analysis";
        const header = [
          `## ${label} (${analysis.model})${fallbackNote}`,
          ...imageList,
          "",
        ].join("\n");

        const result = `${header}${analysis.text}`;
        return textResult(truncateToLimit(result, CHARACTER_LIMIT));
      } catch (error) {
        return errorResult(describeApiError(error));
      }
    }
  );
}
