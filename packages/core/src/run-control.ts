import type { RunControl, RunControlContext, RunControlDecision } from "./ports.ts";

export class ContinueRunControl implements RunControl {
  async decide(_context: RunControlContext): Promise<RunControlDecision> {
    return "CONTINUE";
  }
}

export class MutableRunControl implements RunControl {
  private requested: RunControlDecision = "CONTINUE";

  requestPause(): void {
    this.requested = "PAUSE";
  }

  requestCancel(): void {
    this.requested = "CANCEL";
  }

  continue(): void {
    this.requested = "CONTINUE";
  }

  async decide(_context: RunControlContext): Promise<RunControlDecision> {
    return this.requested;
  }
}
