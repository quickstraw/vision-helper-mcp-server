import { test } from "node:test";
import assert from "node:assert/strict";
import { errorResult, textResult, truncateToLimit } from "../src/services/results.js";

test("truncateToLimit keeps short text and truncates long text", () => {
  assert.equal(truncateToLimit("abc", 5), "abc");
  const truncated = truncateToLimit("abcdef", 5);
  assert.ok(truncated.startsWith("abcd…"));
  assert.ok(truncated.includes("[Response truncated at 5 characters"));
});

test("textResult and errorResult produce expected shapes", () => {
  assert.deepEqual(textResult("hi"), { content: [{ type: "text", text: "hi" }] });
  const err = errorResult("boom");
  assert.equal(err.isError, true);
  assert.equal(err.content[0].type, "text");
  assert.equal(err.content[0].text, "boom");
});
