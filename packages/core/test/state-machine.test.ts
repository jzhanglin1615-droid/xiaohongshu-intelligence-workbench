import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchError, classifyUnknownError } from "../src/errors.ts";
import {
  InvalidTransitionError,
  allowedEvents,
  transitionTask,
  type TaskEvent,
} from "../src/state-machine.ts";
import type { TaskState } from "../../contracts/src/index.ts";

const transitions: Array<[TaskState, TaskEvent, TaskState]> = [
  ["DRAFT", "CONFIGURE", "READY"],
  ["DRAFT", "CANCEL", "CANCELLED"],
  ["READY", "START", "RUNNING"],
  ["READY", "CANCEL", "CANCELLED"],
  ["RUNNING", "PAUSE", "PAUSED"],
  ["RUNNING", "REQUIRE_HUMAN", "NEEDS_HUMAN"],
  ["RUNNING", "FAIL", "FAILED"],
  ["RUNNING", "COMPLETE", "COMPLETED"],
  ["RUNNING", "CANCEL", "CANCELLED"],
  ["PAUSED", "RESUME", "RUNNING"],
  ["PAUSED", "CANCEL", "CANCELLED"],
  ["NEEDS_HUMAN", "RESOLVE_HUMAN", "RUNNING"],
  ["NEEDS_HUMAN", "FAIL", "FAILED"],
  ["NEEDS_HUMAN", "CANCEL", "CANCELLED"],
  ["FAILED", "RETRY", "READY"],
  ["FAILED", "CANCEL", "CANCELLED"],
];

test("every declared task transition reaches the expected state", () => {
  for (const [current, event, expected] of transitions) {
    assert.equal(transitionTask(current, event), expected, `${current} --${event}--> ${expected}`);
    assert.ok(allowedEvents(current).includes(event));
  }
});

test("terminal states reject further transitions", () => {
  for (const state of ["COMPLETED", "CANCELLED"] as const) {
    assert.deepEqual(allowedEvents(state), []);
    assert.throws(
      () => transitionTask(state, "START"),
      (error: unknown) => error instanceof InvalidTransitionError && error.current === state,
    );
  }
});

test("known and unknown failures keep an explicit taxonomy", () => {
  const known = classifyUnknownError(new WorkbenchError({
    category: "NEEDS_HUMAN",
    code: "LOGIN_REQUIRED",
    message: "User intervention is required.",
    targetId: "note-001",
  }), "ignored");
  assert.deepEqual(known, {
    targetId: "note-001",
    category: "NEEDS_HUMAN",
    code: "LOGIN_REQUIRED",
    message: "User intervention is required.",
    retryable: false,
  });
  assert.deepEqual(classifyUnknownError(new Error("boom"), "note-002"), {
    targetId: "note-002",
    category: "PERMANENT",
    code: "UNEXPECTED_ERROR",
    message: "boom",
    retryable: false,
  });
});
