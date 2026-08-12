/** vision_helper_analyze_image tool: send one or more images to an OpenRouter vision model. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import {
  CHARACTER_LIMIT,
  DEFAULT_ANALYSIS_PROMPT,
  DEFAULT_MODEL,
  MAX_TOTAL_IMAGE_BYTES,
  SUPPORTED_FORMATS,
} from "../constants.js";
import { getApiKey, getEffectiveDefaultModel, getMaxImageSize, getRequestTimeoutMs } from "../config.js";
import { loadImage } from "../services/images.js";
import { analyzeImage, describeApiError } from "../services/openrouter.js";
import { errorResult, missingApiKeyResult, textResult } from "../services/results.js";
import { AnalyzeImageSchema } from "../schemas.js";

type AnalyzeImageParams = z.infer<typeof AnalyzeImageSchema>;

function truncateToLimit(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return (
    `${text.slice(0, limit - 1)}…\n\n` +
    `[Response truncated at ${limit} characters. Ask for a shorter analysis if more is needed.]`
  );
}

export function registerAnalyzeImageTool(server: McpServer): void {
  server.registerTool(
    "vision_helper_analyze_image",
    {
      title: "Analyze Image with a Vision Model (Vision Helper)",
      description: `Analyze one or more images using a vision-capable model from OpenRouter. Use this whenever you need to know what is in an image but you cannot see images yourself.

This is the Vision Helper MCP server's own analysis tool (distinct from any other vision server you may have configured). It loads the image(s) — from a URL, a local file path, a file:// URI, a data: URI, or raw base64 — and sends them to a vision model, then returns that model's analysis as text.

Security notes: local files are read and sent to OpenRouter only when explicitly requested; only image content is uploaded and only if it is a supported format (${SUPPORTED_FORMATS}, per OpenRouter). Remote URLs are validated against private/internal hosts and redirects before fetching.

Args:
  - image (string | string[]): Image source(s). Accepted forms: http(s) URL, local file path, file:// URI, data: URI (data:image/png;base64,...), or raw base64. Pass an array to analyze several images together (e.g. to compare them). Relative file paths resolve against the MCP client's working directory — prefer absolute paths or URLs.
  - prompt (string, optional): What the vision model should look for, e.g. 'Transcribe all text in this screenshot' or 'Describe the objects and colors'. Defaults to a general detailed description.
  - model (string, optional): OpenRouter model ID, e.g. 'google/gemini-3.6-flash'. Defaults to the OPENROUTER_MODEL environment variable, then to '${DEFAULT_MODEL}'. Use vision_helper_list_models to see current options.
  - max_tokens (number, optional): Max tokens for the answer (64-16000).
  - temperature (number, optional): Sampling temperature (0-2).

Returns:
  Text containing the vision model's analysis, prefixed with the model and image sources used. Long analyses are truncated at ${CHARACTER_LIMIT} characters with a marker.

Examples:
  - "What is in this image? https://example.com/photo.jpg" -> image="https://example.com/photo.jpg"
  - "Read the text in this screenshot: C:\\Users\\me\\Pictures\\shot.png" -> image="C:\\Users\\me\\Pictures\\shot.png"
  - "Compare these two images: img1.png and img2.png" -> image=["img1.png", "img2.png"]

Error Handling:
  - "Error: No OpenRouter API key found..." -> run vision_helper_check_config to see how keys are resolved.
  - "Error: Model not found..." -> run vision_helper_list_models and pass a valid model id.
  - "Error: Image is N bytes, which exceeds MAX_IMAGE_SIZE..." -> shrink the image or raise MAX_IMAGE_SIZE.
  - "Error: ... only accept PNG, JPEG, WebP, or GIF ..." -> convert the image to a supported format.`,
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
        const keyInfo = await getApiKey();
        if (keyInfo === null) {
          return missingApiKeyResult();
        }

        const model = params.model?.trim() || (await getEffectiveDefaultModel());
        const maxImageSize = await getMaxImageSize();
        const timeoutMs = await getRequestTimeoutMs();

        const sources = Array.isArray(params.image) ? params.image : [params.image];
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

        const prompt = params.prompt?.trim() || DEFAULT_ANALYSIS_PROMPT;
        const analysis = await analyzeImage({
          apiKey: keyInfo.value,
          model,
          images,
          prompt,
          maxTokens: params.max_tokens,
          temperature: params.temperature,
          timeoutMs,
        });

        const imageList = images.map((img) => `- ${img.sourceLabel} (${img.mimeType}, ${img.byteLength} bytes)`);
        const header = [
          `## Vision analysis (${model})`,
          ...imageList,
          "",
        ].join("\n");

        const result = `${header}${analysis}`;
        return textResult(truncateToLimit(result, CHARACTER_LIMIT));
      } catch (error) {
        return errorResult(describeApiError(error));
      }
    }
  );
}
