#!/usr/bin/env node
/**
 * Vision Helper MCP Server.
 *
 * Adds vision capability to any LLM by routing image analysis to
 * vision-capable models on OpenRouter.
 *
 * Tools:
 *   - vision_helper_analyze_image : analyze image(s) from URL / file path / base64
 *                                   (pass quick: true for fast, cheap analysis)
 *   - vision_helper_list_models   : list vision models currently on OpenRouter
 *   - vision_helper_check_config  : diagnose API key / model configuration
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { STDIO_MAX_BUFFER_SIZE } from "./constants.js";
import { registerAnalyzeImageTool } from "./tools/analyzeImage.js";
import { registerListModelsTool } from "./tools/listModels.js";
import { registerCheckConfigTool } from "./tools/checkConfig.js";

/**
 * Read the package version from the shipped package.json. The package.json is
 * one directory above both src/ and dist/, so the same relative lookup works
 * in development and when run from the installed npm tarball.
 */
function readServerVersion(): string {
  try {
    const packagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) return parsed.version;
  } catch {
    /* not present/parse/unreadable — fall through to a placeholder */
  }
  return "0.0.0";
}

const USAGE = `Vision Helper MCP Server
Adds vision capability to any LLM via OpenRouter vision models.

Usage: vision-helper-mcp [--help]

Tools:
  vision_helper_analyze_image  Analyze image(s) from URL, file path, data URI, or base64
                               (pass quick: true for fast, cheap analysis)
  vision_helper_list_models    List vision-capable models on OpenRouter
  vision_helper_check_config   Show where the API key and default model are loaded from

Configuration (environment variables):
  OPENROUTER_API_KEY     Required. Set in the MCP client's env config, or as a
                         Windows user environment variable (setx OPENROUTER_API_KEY ...)
  OPENROUTER_MODEL       Optional. Default vision model ID.
  OPENROUTER_FALLBACK_MODEL Optional. Fallback model tried automatically when
                         the primary model's provider is busy/fails
                         (default google/gemini-3.7-flash).
  OPENROUTER_QUICK_MODEL Optional. Default model ID when quick: true is passed to
                         vision_helper_analyze_image (default meta/muse-glimmer-30b).
  MAX_IMAGE_SIZE         Optional. Max image payload bytes (default 10485760).
  OPENROUTER_TIMEOUT_MS  Optional. Request timeout in ms (default 120000).

Run via stdio as an MCP server; there is no interactive shell.
`;

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const server = new McpServer({
    name: "vision-helper-mcp-server",
    version: readServerVersion(),
  });

  registerAnalyzeImageTool(server);
  registerListModelsTool(server);
  registerCheckConfigTool(server);

  const transport = new StdioServerTransport(undefined, undefined, { maxBufferSize: STDIO_MAX_BUFFER_SIZE });
  await server.connect(transport);
  console.error("Vision Helper MCP server running via stdio");
}

main().catch((error: unknown) => {
  console.error("Fatal server error:", error);
  process.exit(1);
});
