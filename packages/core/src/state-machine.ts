import type { TaskState } from "../../contracts/src/index.ts";

export type TaskEvent =
  | "CONFIGURE"
  | "START"
  | "PAUSE"
  | "RESUME"
  | "REQUIRE_HUMAN"
  | "RESOLVE_HUMAN"
  | "FAIL"
  | "RETRY"
  | "COMPLETE"
  | "CANCEL";

const TRANSITIONS: Record<TaskState, Partial<Record<TaskEvent, TaskState>>> = {
  DRAFT: { CONFIGURE: "READY", CANCEL: "CANCELLED" },
  READY: { START: "RUNNING", CANCEL: "CANCELLED" },
  RUNNING: {
    PAUSE: "PAUSED",
    REQUIRE_HUMAN: "NEEDS_HUMAN",
    FAIL: "FAILED",
    COMPLETE: "COMPLETED",
    CANCEL: "CANCELLED",
  },
  PAUSED: { RESUME: "RUNNING", CANCEL: "CANCELLED" },
  NEEDS_HUMAN: { RESOLVE_HUMAN: "RUNNING", FAIL: "FAILED", CANCEL: "CANCELLED" },
  FAILED: { RETRY: "READY", CANCEL: "CANCELLED" },
  COMPLETED: {},
  CANCELLED: {},
};

export class InvalidTransitionError extends Error {
  readonly current: TaskState;
  readonly event: TaskEvent;

  constructor(current: TaskState, event: TaskEvent) {
    super(`Invalid task transition: ${current} --${event}--> ?`);
    this.name = "InvalidTransitionError";
    this.current = current;
    this.event = event;
  }
}

export function transitionTask(current: TaskState, event: TaskEvent): TaskState {
  const next = TRANSITIONS[current][event];
  if (!next) throw new InvalidTransitionError(current, event);
  return next;
}

export function allowedEvents(current: TaskState): TaskEvent[] {
  return Object.keys(TRANSITIONS[current]) as TaskEvent[];
}
