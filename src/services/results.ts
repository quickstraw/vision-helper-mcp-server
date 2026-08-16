/** Small shared helpers for building tool results. */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Truncate long result text at `limit` characters, appending a marker plus
 * guidance so the calling model knows the response was cut short.
 */
export function truncateToLimit(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return (
    `${text.slice(0, limit - 1)}…\n\n` +
    `[Response truncated at ${limit} characters. Ask for a shorter analysis if more is needed.]`
  );
}

/** Single source of truth for the "API key not configured" error. */
export function missingApiKeyResult(): CallToolResult {
  return errorResult(
    "Error: No OpenRouter API key found. Set OPENROUTER_API_KEY in your MCP client's " +
      "environment, or set it as a Windows user environment variable with: " +
      "setx OPENROUTER_API_KEY sk-or-v1-... (then restart the MCP client). " +
      "Run vision_helper_check_config to verify."
  );
}
