/** vision_helper_list_models tool: discover vision-capable models currently on OpenRouter. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { getApiKey } from "../config.js";
import { describeApiError, listVisionModels } from "../services/openrouter.js";
import { errorResult, missingApiKeyResult, textResult } from "../services/results.js";
import { ListModelsSchema } from "../schemas.js";

type ListModelsParams = z.infer<typeof ListModelsSchema>;

function formatPrice(pricePerM: number): string {
  if (pricePerM <= 0) return "n/a";
  return `$${pricePerM.toFixed(pricePerM < 0.01 ? 4 : 2)}/1M tokens`;
}

export function registerListModelsTool(server: McpServer): void {
  server.registerTool(
    "vision_helper_list_models",
    {
      title: "List Vision Models (Vision Helper)",
      description: `List vision-capable models currently available on OpenRouter, so you or the user can pick one for image analysis. Use it to find a valid model ID (e.g. when a configured model fails) or when asked which models are available. Narrow with 'search' (substring on provider or family, e.g. 'gemini', 'qwen') and paginate with limit/offset. Returns model IDs with context length and input price.`,
      inputSchema: ListModelsSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListModelsParams) => {
      try {
        const keyInfo = await getApiKey();
        if (keyInfo === null) {
          return missingApiKeyResult();
        }

        const all = await listVisionModels(keyInfo.value);
        const needle = params.search?.toLowerCase();
        const filtered = needle
          ? all.filter((m) => m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle))
          : all;

        const page = filtered.slice(params.offset, params.offset + params.limit);
        const hasMore = params.offset + page.length < filtered.length;
        const nextOffset = hasMore ? params.offset + page.length : undefined;

        if (page.length === 0) {
          return textResult(
            `No vision models matched ${needle ? `'${params.search}'` : "the filter"}. ` +
              `Try a broader search (e.g. 'gemini', 'qwen', 'claude'), or run without 'search'.`
          );
        }

        const lines: string[] = [
          `# Vision models on OpenRouter (${filtered.length} total, showing ${page.length})`,
          "",
        ];
        for (const m of page) {
          const ctx = m.contextLength > 0 ? `${Math.round(m.contextLength / 1024)}K ctx` : "ctx n/a";
          lines.push(`- **${m.id}** — ${ctx} — input ${formatPrice(m.promptPricePerM)}`);
        }
        lines.push("");
        if (hasMore) {
          lines.push(`More models available. Call again with offset=${nextOffset}, or narrow with 'search'.`);
        } else if (needle) {
          lines.push("All matches shown. Remove 'search' to see the full catalog.");
        }
        return textResult(lines.join("\n"));
      } catch (error) {
        return errorResult(describeApiError(error));
      }
    }
  );
}
