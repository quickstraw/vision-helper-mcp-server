/** vision_helper_check_config tool: report where the API key and model are loaded from. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_FALLBACK_MODEL, DEFAULT_MODEL, DEFAULT_QUICK_MODEL } from "../constants.js";
import {
  getApiKey,
  getConfiguredModel,
  getEffectiveFallbackModel,
  getEffectiveQuickModel,
  getMaxImageSize,
  getRequestTimeoutMs,
  maskKey,
} from "../config.js";
import { textResult } from "../services/results.js";
import { CheckConfigSchema } from "../schemas.js";

export function registerCheckConfigTool(server: McpServer): void {
  server.registerTool(
    "vision_helper_check_config",
    {
      title: "Check Vision Helper MCP Configuration",
      description: `Diagnose why vision analysis may be failing. Reports whether an OpenRouter API key is configured, where it was loaded from (MCP client environment, Windows user environment variables, or Windows system environment variables), which model would be used by default, and the configured size/time limits.

The key is only shown masked (e.g. sk-or-v1-…a0) — never in full.

Args:
  - (none)

Returns:
  A short markdown report with:
  - API key: present or missing, plus the source it was resolved from.
  - Default model: from OPENROUTER_MODEL, or the built-in default ('${DEFAULT_MODEL}').
  - Quick model: from OPENROUTER_QUICK_MODEL, or the built-in default ('${DEFAULT_QUICK_MODEL}').
  - Fallback model: tried automatically if the default model's provider is busy ('${DEFAULT_FALLBACK_MODEL}').
  - MAX_IMAGE_SIZE and request timeout.

Examples:
  - Use when vision_helper_analyze_image fails with "No OpenRouter API key found" to confirm where keys are (or are not) configured.`,
      inputSchema: CheckConfigSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const keyInfo = await getApiKey();
      const modelInfo = await getConfiguredModel();
      const quickModel = await getEffectiveQuickModel();
      const fallbackModel = await getEffectiveFallbackModel();
      const maxImageSize = await getMaxImageSize();
      const timeoutMs = await getRequestTimeoutMs();

      const lines: string[] = [
        "# Vision Helper MCP configuration",
        "",
        keyInfo === null
          ? "- **API key: MISSING** — Set OPENROUTER_API_KEY in your MCP client's environment, or run: setx OPENROUTER_API_KEY sk-or-v1-... (then fully restart the MCP client so it picks up the new value)."
          : `- **API key: present** (${maskKey(keyInfo.value)}) — resolved from: ${keyInfo.source}`,
        modelInfo === null
          ? `- **Default model: not configured** — will fall back to '${DEFAULT_MODEL}'. Set OPENROUTER_MODEL, or pass a 'model' argument to vision_helper_analyze_image.`
          : `- **Default model: '${modelInfo.value}'** (from ${modelInfo.source}) — pass a 'model' argument to vision_helper_analyze_image to override per call.`,
        `- **Quick model: '${quickModel}'** — used by vision_helper_quick_analyze. Set OPENROUTER_QUICK_MODEL, or pass a 'model' argument to override per call.`,
        `- **Fallback model: '${fallbackModel}'** — used automatically by vision_helper_analyze_image if the primary model's provider is busy or errors (429/5xx/timeout/network). Set OPENROUTER_FALLBACK_MODEL to override.`,
        `- **MAX_IMAGE_SIZE: ${maxImageSize} bytes** (${(maxImageSize / 1024 / 1024).toFixed(1)} MB)`,
        `- **Request timeout: ${timeoutMs / 1000}s**`,
      ];

      return textResult(lines.join("\n"));
    }
  );
}
