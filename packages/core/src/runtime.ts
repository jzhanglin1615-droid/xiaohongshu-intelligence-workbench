import { randomUUID } from "node:crypto";
import type { Clock, IdProvider } from "./ports.ts";

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

export class RandomIdProvider implements IdProvider {
  next(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }
}

export class FixedClock implements Clock {
  private readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  now(): string {
    return this.value;
  }
}

export class SequenceIdProvider implements IdProvider {
  private sequence = 0;

  next(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${String(this.sequence).padStart(4, "0")}`;
  }
}
