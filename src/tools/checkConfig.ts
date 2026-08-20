/** vision_helper_check_config tool: report where the API key and model are loaded from. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_MODEL } from "../constants.js";
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
      title: "Check Vision Helper Configuration",
      description: `Diagnose vision analysis configuration problems. Reports whether the OpenRouter API key is set and where it was loaded from, which models would be used (default, quick, fallback), and the configured size/time limits. The key is only shown masked. Run this when analysis fails with a missing-key or configuration error.`,
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
          ? "- **API key: MISSING** — Set OPENROUTER_API_KEY in your MCP client's environment (then restart the client), or run: setx OPENROUTER_API_KEY sk-or-v1-... (the server re-reads the registry periodically, so no client restart is needed)."
          : `- **API key: present** (${maskKey(keyInfo.value)}) — resolved from: ${keyInfo.source}`,
        modelInfo === null
          ? `- **Default model: not configured** — will fall back to '${DEFAULT_MODEL}'. Set OPENROUTER_MODEL, or pass a 'model' argument to vision_helper_analyze_image.`
          : `- **Default model: '${modelInfo.value}'** (from ${modelInfo.source}) — pass a 'model' argument to vision_helper_analyze_image to override per call.`,
        `- **Quick model: '${quickModel}'** — used when 'quick: true' is passed to vision_helper_analyze_image. Set OPENROUTER_QUICK_MODEL, or pass a 'model' argument to override per call.`,
        `- **Fallback model: '${fallbackModel}'** — used automatically by vision_helper_analyze_image if the primary model's provider is busy or errors (429/5xx/timeout/network). Set OPENROUTER_FALLBACK_MODEL to override.`,
        `- **MAX_IMAGE_SIZE: ${maxImageSize} bytes** (${(maxImageSize / 1024 / 1024).toFixed(1)} MB)`,
        `- **Request timeout: ${timeoutMs / 1000}s**`,
      ];

      return textResult(lines.join("\n"));
    }
  );
}
