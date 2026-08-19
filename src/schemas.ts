/** Zod input schemas for the Vision Helper MCP tools. */

import { z } from "zod";
import { MAX_IMAGE_COUNT } from "./constants.js";

export const AnalyzeImageSchema = z
  .object({
    image: z
      .union([
        z
          .string()
          .min(1)
          .describe(
            "A single image. Accepted forms: an http(s) URL, a local file path, a file:// URI, a data: URI (data:image/png;base64,...), or a raw base64 string."
          ),
        z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_IMAGE_COUNT)
          .describe(`Multiple images (up to ${MAX_IMAGE_COUNT}) analyzed together, e.g. to compare screenshots.`),
      ])
      .describe("Image to analyze: a URL, local file path, data URI, raw base64, or an array of these."),
    prompt: z
      .string()
      .min(1)
      .max(2_000)
      .optional()
      .describe(
        "Optional instruction for the vision model describing what to look for. " +
          "Example: 'Transcribe all text in this screenshot'. When omitted, a general detailed description is used."
      ),
    model: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "OpenRouter model ID to use for vision analysis, e.g. 'qwen/qwen3.8-max'. " +
          "Defaults to the OPENROUTER_MODEL environment variable, then to a built-in default. " +
          "Use vision_helper_list_models to discover current vision-capable models."
      ),
    max_tokens: z
      .number()
      .int()
      .min(64)
      .max(16_000)
      .optional()
      .describe("Maximum number of tokens for the vision model's answer."),
    temperature: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe("Sampling temperature (0-2). Lower is more deterministic."),
    quick: z
      .boolean()
      .optional()
      .describe(
        "Set true for a fast, cheap analysis of a single image: uses the quick model " +
          "(OPENROUTER_QUICK_MODEL), caps output at 1024 tokens, and forces minimal reasoning. " +
          "Good for a quick yes/no, a short caption, or an object/color check."
      ),
  })
  .strict();

export const ListModelsSchema = z
  .object({
    search: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("Case-insensitive substring filter on model ID or name, e.g. 'gemini', 'qwen', 'gpt'."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe("Maximum number of models to return."),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Number of models to skip, for pagination."),
  })
  .strict();

export const CheckConfigSchema = z.object({}).strict();
