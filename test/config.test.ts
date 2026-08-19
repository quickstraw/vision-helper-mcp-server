import { test } from "node:test";
import assert from "node:assert/strict";
import { expandRegistryValue, maskKey, parseRegOutput } from "../src/config.js";

test("parseRegOutput parses REG_SZ and REG_EXPAND_SZ lines", () => {
  const stdout = [
    "HKEY_CURRENT_USER\\Environment",
    "    OPENROUTER_API_KEY    REG_SZ    sk-or-v1-abc123",
    "    PATH    REG_EXPAND_SZ    C:\\tools;%USERPROFILE%\\bin",
    "    SOME_KEY    REG_DWORD    0x1",
  ].join("\n");
  assert.deepEqual(parseRegOutput(stdout), {
    OPENROUTER_API_KEY: { value: "sk-or-v1-abc123", expand: false },
    PATH: { value: "C:\\tools;%USERPROFILE%\\bin", expand: true },
  });
});

test("parseRegOutput handles empty and malformed input", () => {
  assert.deepEqual(parseRegOutput(""), {});
  assert.deepEqual(parseRegOutput("HKEY_CURRENT_USER\\Environment\n(Default)    REG_SZ\n"), {});
});

test("expandRegistryValue expands known, unknown, and missing variables", () => {
  const all = { USERPROFILE: "C:\\Users\\me" };
  assert.equal(expandRegistryValue("C:\\x;%USERPROFILE%\\y", all), "C:\\x;C:\\Users\\me\\y");
  assert.equal(expandRegistryValue("%MISSING%", all), "");
  assert.equal(expandRegistryValue("%USERPROFILE%\\%MISSING%", all), "C:\\Users\\me\\");
  assert.equal(expandRegistryValue("no vars", all), "no vars");
});

test("maskKey masks long keys and short strings", () => {
  assert.equal(maskKey("sk-or-v1-0123456789abcdef"), "sk-or-…cdef");
  assert.equal(maskKey("short"), "***");
});
