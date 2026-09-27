import assert from "node:assert/strict";
import test from "node:test";
import {
  ALLOWED_BROWSER_COMMANDS,
  BROWSER_PROTOCOL_VERSION,
  validateBrowserMessage,
} from "../src/protocol.ts";

const validRequest = {
  protocolVersion: BROWSER_PROTOCOL_VERSION,
  kind: "CAPTURE_VISIBLE_PAGE",
  correlationId: "task-001-1",
  taskId: "task-001",
  expectedPageType: "SEARCH",
  issuedAt: "2026-09-24T00:00:00.000Z",
  readOnly: true,
  authorization: {
    readVisiblePages: true,
    interactiveActions: false,
  },
};

test("read-only capture request satisfies the browser protocol", () => {
  assert.deepEqual(ALLOWED_BROWSER_COMMANDS, ["CAPTURE_VISIBLE_PAGE"]);
  assert.deepEqual(validateBrowserMessage(validRequest), { ok: true, errors: [] });
});

test("mutation commands are outside the browser protocol", () => {
  const result = validateBrowserMessage({ ...validRequest, kind: "CLICK_ELEMENT" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /not allowed/);
});

test("capture request cannot enable interactive actions", () => {
  const result = validateBrowserMessage({
    ...validRequest,
    readOnly: false,
    authorization: { readVisiblePages: true, interactiveActions: true },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /readOnly must be true/);
  assert.match(result.errors.join(" "), /interactiveActions must be false/);
});
