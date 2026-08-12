/**
 * Configuration resolution for the Vision Helper MCP server.
 *
 * API keys and options are resolved in this priority order:
 *   1. Process environment variables (set by the MCP client's `env` config,
 *      or exported in the terminal that launched the client).
 *   2. Windows user environment variables, read directly from the registry
 *      (HKCU\Environment). This is what `setx OPENROUTER_API_KEY ...` writes,
 *      and it matters because GUI apps (VS Code, Claude Desktop, Kilo, ...)
 *      often do NOT inherit user env vars changed after they were launched.
 *   3. Windows system environment variables (HKLM\...\Session
 *      Manager\Environment).
 *
 * Reading the registry directly makes a key set with `setx` work even when
 * the MCP client was started from a GUI and never re-read its environment.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ABSOLUTE_MAX_IMAGE_SIZE,
  DEFAULT_MAX_IMAGE_SIZE,
  DEFAULT_MODEL,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "./constants.js";

const execFileAsync = promisify(execFile);

const REG_USER_ENV = "HKCU\\Environment";
const REG_SYSTEM_ENV = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

interface RegistryEntry {
  value: string;
  expand: boolean;
}

type RegistryEnv = Record<string, RegistryEntry>;

export interface ResolvedValue {
  value: string;
  source: string;
}

let registryCache: { user: RegistryEnv; system: RegistryEnv } | null = null;

function isWindows(): boolean {
  return process.platform === "win32";
}

/** Parse `reg query` output into { NAME -> { value, expand } }. */
function parseRegOutput(stdout: string): RegistryEnv {
  const result: RegistryEnv = {};
  const lineRe = /^\s*(.+?)\s+REG_(EXPAND_)?SZ\s+(.*)$/;
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(lineRe);
    if (!match) continue;
    const name = match[1]!.trim();
    const value = match[3]!.trim();
    if (name.length > 0 && value.length > 0) {
      result[name] = { value, expand: match[2] === "EXPAND_" };
    }
  }
  return result;
}

async function readRegistryEnv(scope: "user" | "system"): Promise<RegistryEnv> {
  if (!isWindows()) return {};
  try {
    const { stdout } = await execFileAsync("reg", ["query", scope === "user" ? REG_USER_ENV : REG_SYSTEM_ENV], {
      windowsHide: true,
      timeout: 5_000,
    });
    return parseRegOutput(stdout);
  } catch {
    return {};
  }
}

async function getRegistryEnv(): Promise<{ user: RegistryEnv; system: RegistryEnv }> {
  if (registryCache === null) {
    registryCache = {
      user: await readRegistryEnv("user"),
      system: await readRegistryEnv("system"),
    };
  }
  return registryCache;
}

/** Expand %VAR% references (REG_EXPAND_SZ) using process env + registry values. */
function expandRegistryValue(raw: string, all: Record<string, string>): string {
  return raw.replace(/%([^%]+)%/g, (_match, name: string) => all[name] ?? "");
}

/**
 * Look up an environment value across the three sources.
 * Returns the value plus a human-readable description of where it came from.
 */
export async function lookupEnv(name: string): Promise<ResolvedValue | null> {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess.length > 0) {
    return { value: fromProcess, source: "MCP client environment (process env)" };
  }
  if (isWindows()) {
    const reg = await getRegistryEnv();
    // Expansion map is built in ascending priority so higher-priority scopes win:
    // system (lowest) -> user -> process (highest). Later assignments overwrite
    // earlier ones, matching Windows %VAR% expansion semantics.
    const expandMap: Record<string, string> = {};
    for (const scope of [reg.system, reg.user] as const) {
      for (const [key, entry] of Object.entries(scope)) {
        expandMap[key] = expandRegistryValue(entry.value, expandMap);
      }
    }
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) expandMap[key] = value;
    }
    for (const [scope, label] of [
      [reg.user, "Windows user environment variables (setx)"],
      [reg.system, "Windows system environment variables"],
    ] as const) {
      const entry = scope[name];
      if (entry !== undefined) {
        return { value: expandRegistryValue(entry.value, expandMap), source: label };
      }
    }
  }
  return null;
}

/** Resolve the OpenRouter API key, or null when it is not configured anywhere. */
export async function getApiKey(): Promise<ResolvedValue | null> {
  return lookupEnv("OPENROUTER_API_KEY");
}

/** Resolve the configured OpenRouter model, or null to fall back to DEFAULT_MODEL. */
export async function getConfiguredModel(): Promise<ResolvedValue | null> {
  return lookupEnv("OPENROUTER_MODEL");
}

/** Resolve the maximum image payload size in bytes (MAX_IMAGE_SIZE). */
export async function getMaxImageSize(): Promise<number> {
  const resolved = await lookupEnv("MAX_IMAGE_SIZE");
  if (resolved === null) return DEFAULT_MAX_IMAGE_SIZE;
  const parsed = Number.parseInt(resolved.value, 10);
  if (Number.isNaN(parsed) || parsed < 1024) return DEFAULT_MAX_IMAGE_SIZE;
  return Math.min(parsed, ABSOLUTE_MAX_IMAGE_SIZE);
}

/** Resolve the request timeout in milliseconds (OPENROUTER_TIMEOUT_MS). */
export async function getRequestTimeoutMs(): Promise<number> {
  const resolved = await lookupEnv("OPENROUTER_TIMEOUT_MS");
  if (resolved === null) return DEFAULT_REQUEST_TIMEOUT_MS;
  const parsed = Number.parseInt(resolved.value, 10);
  if (Number.isNaN(parsed) || parsed < 5_000) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(parsed, 600_000);
}

/** Model that would be used if the caller passes no `model` argument. */
export async function getEffectiveDefaultModel(): Promise<string> {
  const configured = (await getConfiguredModel())?.value.trim();
  return configured !== undefined && configured.length > 0 ? configured : DEFAULT_MODEL;
}

/** Short, safe mask of a key for diagnostics (e.g. "sk-or-…a0"). */
export function maskKey(key: string): string {
  if (key.length <= 12) return "***";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
