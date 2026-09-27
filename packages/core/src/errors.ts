import type { ErrorCategory, TaskError } from "../../contracts/src/index.ts";

export class WorkbenchError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly targetId: string;
  readonly retryable: boolean;

  constructor(input: {
    category: ErrorCategory;
    code: string;
    message: string;
    targetId: string;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = "WorkbenchError";
    this.category = input.category;
    this.code = input.code;
    this.targetId = input.targetId;
    this.retryable = input.retryable ?? input.category === "RETRYABLE";
  }

  toTaskError(): TaskError {
    return {
      targetId: this.targetId,
      category: this.category,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export function classifyUnknownError(error: unknown, targetId: string): TaskError {
  if (error instanceof WorkbenchError) return error.toTaskError();
  return {
    targetId,
    category: "PERMANENT",
    code: "UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}
