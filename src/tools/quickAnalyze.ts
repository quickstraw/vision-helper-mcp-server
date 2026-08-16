/** vision_helper_quick_analyze tool: fast, cheap image analysis for time-sensitive checks. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import {
  CHARACTER_LIMIT,
  DEFAULT_QUICK_MODEL,
  DEFAULT_QUICK_PROMPT,
  MAX_IMAGE_COUNT,
  MAX_TOTAL_IMAGE_BYTES,
  QUICK_DEFAULT_MAX_TOKENS,
  QUICK_REASONING_EFFORT,
} from "../constants.js";
import { getApiKey, getEffectiveQuickModel, getMaxImageSize, getRequestTimeoutMs } from "../config.js";
import { loadImage } from "../services/images.js";
import { analyzeImage, describeApiError } from "../services/openrouter.js";
import { errorResult, missingApiKeyResult, textResult, truncateToLimit } from "../services/results.js";
import { QuickAnalyzeImageSchema } from "../schemas.js";

type QuickAnalyzeParams = z.infer<typeof QuickAnalyzeImageSchema>;

export function registerQuickAnalyzeTool(server: McpServer): void {
  server.registerTool(
    "vision_helper_quick_analyze",
    {
      title: "Quick Analyze an Image (Vision Helper)",
      description: `Analyze an image fast and cheap for time-sensitive checks. This is the **fast, low-cost** analysis tool.

Use this when you need a quick answer about a single image and can accept a concise result: a yes/no, a short caption or summary, an object/color check, or "is this image blurry/empty/correct?". It is ideal when latency and cost matter (e.g. high-volume or time-sensitive checks), because it uses a cheap, high-throughput default model ('${DEFAULT_QUICK_MODEL}'), caps output at ${QUICK_DEFAULT_MAX_TOKENS} tokens, and forces minimal reasoning (effort '${QUICK_REASONING_EFFORT}').

When NOT to use this: if you need a detailed, thorough analysis — transcribing all readable text, describing objects/people/layout in full, reasoning about ambiguous or complex content, or comparing multiple images — use vision_helper_analyze_image instead, which uses a higher-quality model and can analyze up to ${MAX_IMAGE_COUNT} images together. Choose quick_analyze for speed/cost over detail; choose analyze_image when completeness or precision matters more.

This is distinct from vision_helper_analyze_image: it accepts a single image (URL, file path, file:// URI, data: URI, or base64) and returns a shorter, to-the-point description.

Security notes: local files are read and sent to OpenRouter only when explicitly requested; only image content is uploaded and only if it is a supported format (PNG, JPEG, WebP, or GIF, per OpenRouter). Remote URLs are validated against private/internal hosts and redirects before fetching.

Args:
  - image (string): Image source — http(s) URL, local file path, file:// URI, data: URI, or raw base64. Relative file paths resolve against the MCP client's working directory.
  - prompt (string, optional): A short question or instruction, e.g. 'Is this icon red?'. Keep it brief (max 500 chars). Defaults to a concise description.
  - model (string, optional): OpenRouter model ID. Defaults to the OPENROUTER_QUICK_MODEL environment variable, then to '${DEFAULT_QUICK_MODEL}'.

Returns:
  A short text analysis, prefixed with the model and image source used. Long analyses are truncated at ${CHARACTER_LIMIT} characters with a marker.

Examples:
  - "Quickly, what is in this image? https://example.com/photo.jpg" -> image="https://example.com/photo.jpg"
  - "Describe this screenshot briefly: C:\\Users\\me\\Pictures\\shot.png" -> image="C:\\Users\\me\\Pictures\\shot.png"

Error Handling:
  - "Error: No OpenRouter API key found..." -> run vision_helper_check_config to see how keys are resolved.
  - "Error: Model not found..." -> run vision_helper_list_models and pass a valid model id.
  - "Error: Image is N bytes, which exceeds MAX_IMAGE_SIZE..." -> shrink the image or raise MAX_IMAGE_SIZE.
  - "Error: ... only accept PNG, JPEG, WebP, or GIF ..." -> convert the image to a supported format.`,
      inputSchema: QuickAnalyzeImageSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: QuickAnalyzeParams) => {
      try {
        const keyInfo = await getApiKey();
        if (keyInfo === null) {
          return missingApiKeyResult();
        }

        const model = params.model?.trim() || (await getEffectiveQuickModel());
        const maxImageSize = await getMaxImageSize();
        const timeoutMs = await getRequestTimeoutMs();

        const image = await loadImage(params.image, maxImageSize);

        if (image.byteLength > MAX_TOTAL_IMAGE_BYTES) {
          return errorResult(
            `Error: The image is ${image.byteLength} bytes, exceeding the aggregate ` +
              `limit of ${MAX_TOTAL_IMAGE_BYTES} bytes per request. Use a smaller image.`
          );
        }

        const prompt = params.prompt?.trim() || DEFAULT_QUICK_PROMPT;
        const analysis = await analyzeImage({
          apiKey: keyInfo.value,
          model,
          images: [image],
          prompt,
          timeoutMs,
          quick: true,
        });

        const header = [
          `## Quick vision analysis (${analysis.model})`,
          `- ${image.sourceLabel} (${image.mimeType}, ${image.byteLength} bytes)`,
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