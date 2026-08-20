/** vision_helper_analyze_image tool: send one or more images to an OpenRouter vision model. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import {
  CHARACTER_LIMIT,
  DEFAULT_ANALYSIS_PROMPT,
  DEFAULT_QUICK_PROMPT,
  MAX_IMAGE_COUNT,
  MAX_TOTAL_IMAGE_BYTES,
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
      title: "Analyze Image (Vision Helper)",
      description: `Analyze one or more images with a vision-capable model on OpenRouter and return the analysis as text. Use this whenever you need to know what is in an image but you cannot see it yourself.

Default mode is detailed and thorough (high reasoning effort, high-quality model, automatic retry and fallback). Pass quick: true for a fast, cheap answer (quick model, ~1024-token output, minimal reasoning) — e.g. a yes/no, a caption, or an object check.

Accepts an http(s) URL, local file path, file:// URI, data: URI, or raw base64 (${SUPPORTED_FORMATS} only); pass an array of up to ${MAX_IMAGE_COUNT} to compare images (state the comparison in the prompt). Long analyses are truncated at ${CHARACTER_LIMIT} characters.`,
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
