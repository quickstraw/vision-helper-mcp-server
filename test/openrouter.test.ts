import { test } from "node:test";
import assert from "node:assert/strict";
import { describeApiError, extractContentText, VisionApiError } from "../src/services/openrouter.js";

test("extractContentText handles string and array content", () => {
  assert.equal(extractContentText({ choices: [{ message: { content: "  hello  " } }] }), "hello");
  assert.equal(
    extractContentText({
      choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }],
    }),
    "a\nb"
  );
  assert.equal(extractContentText({ choices: [] }), "(empty response)");
  assert.equal(extractContentText({}), "(empty response)");
});

test("describeApiError maps HTTP statuses to actionable messages", () => {
  assert.match(describeApiError(new VisionApiError(401, "x")), /sk-or-v1-/);
  assert.match(describeApiError(new VisionApiError(402, "x")), /credits/);
  assert.match(describeApiError(new VisionApiError(404, "x", '{"error":{"message":"Model does not exist"}}')), /Model does not exist/);
  assert.match(describeApiError(new VisionApiError(429, "x")), /rate limit/);
  assert.match(describeApiError(new VisionApiError(400, "x", '{"error":{"message":"bad image"}}')), /bad image/);
  assert.match(describeApiError(new VisionApiError(0, "x")), /malformed/);
  assert.match(describeApiError(new VisionApiError(503, "x")), /HTTP 503/);
});

test("describeApiError maps timeout, network, and generic errors", () => {
  const timeout = new Error("boom");
  timeout.name = "TimeoutError";
  assert.match(describeApiError(timeout), /timed out/);
  assert.match(describeApiError(new Error("fetch failed")), /network error/);
  assert.match(describeApiError(new Error("something else")), /Error: something else/);
});
