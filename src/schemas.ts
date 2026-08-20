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
          .describe("A single image: http(s) URL, local file path, file:// URI, data: URI, or raw base64."),
        z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_IMAGE_COUNT)
          .describe(`Multiple images (up to ${MAX_IMAGE_COUNT}) analyzed together for comparison.`),
      ])
      .describe("Image to analyze: URL, file path, data URI, raw base64, or an array of these."),
    prompt: z
      .string()
      .min(1)
      .max(2_000)
      .optional()
      .describe(
        "Optional instruction for the vision model, e.g. 'Transcribe all text in this screenshot'. " +
          "When omitted, a general detailed description is used."
      ),
    model: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "OpenRouter model ID, e.g. 'qwen/qwen3.8-max'. Defaults to OPENROUTER_MODEL, then a built-in default; " +
          "see vision_helper_list_models for options."
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
        "Set true for a fast, cheap analysis: quick model (OPENROUTER_QUICK_MODEL), ~1024-token output, " +
          "minimal reasoning. Good for yes/no checks, captions, object checks, or brief comparisons (up to 5 images)."
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
