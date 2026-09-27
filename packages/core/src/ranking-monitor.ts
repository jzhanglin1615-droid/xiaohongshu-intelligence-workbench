export interface RankingMonitorConfig {
  monitorId: string;
  scopeId: string;
  intervalMs: number;
  enabled: boolean;
}

export interface RankingMonitorScheduleState {
  intervalMs: number;
  nextScheduledAt: string | null;
  pendingScheduledFor: string | null;
  lastScheduledAt: string | null;
  lastCatchUpAt: string | null;
  missedIntervals: number;
  updatedAt: string;
}

export interface RankingScheduleReconciliation {
  state: RankingMonitorScheduleState;
  due: boolean;
  scheduledFor: string | null;
  missedIntervals: number;
  scheduleLagMs: number;
}

export interface RankingMonitorReceipt {
  runId: string;
  monitorId: string;
  trigger: "MANUAL" | "SCHEDULED";
  startedAt: string;
  finishedAt: string;
  status: "SUCCEEDED" | "DISPATCHED" | "FAILED" | "SKIPPED_OVERLAP";
  snapshotId: string | null;
  browserTaskId: string | null;
  errorCode: string | null;
  scheduledFor?: string | null;
  catchUp?: boolean;
  missedIntervals?: number;
  scheduleLagMs?: number;
}

export interface RankingSnapshotRunner {
  capture(scopeId: string): Promise<
    | { kind?: "SNAPSHOT"; snapshotId: string }
    | { kind: "BROWSER_TASK"; browserTaskId: string }
  >;
}

export interface RankingMonitorPersistence {
  initialReceipts?: RankingMonitorReceipt[];
  initialSchedule?: RankingMonitorScheduleState | null;
  onReceipt?: (receipt: RankingMonitorReceipt) => void | Promise<void>;
  onSchedule?: (schedule: RankingMonitorScheduleState) => void | Promise<void>;
}

function validTimestamp(value: string | null | undefined): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function reconcileRankingMonitorSchedule(
  config: RankingMonitorConfig,
  current: RankingMonitorScheduleState | null | undefined,
  now: string,
): RankingScheduleReconciliation {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("INVALID_SCHEDULE_TIME");
  const base: RankingMonitorScheduleState = {
    intervalMs: config.intervalMs,
    nextScheduledAt: null,
    pendingScheduledFor: null,
    lastScheduledAt: null,
    lastCatchUpAt: null,
    missedIntervals: 0,
    updatedAt: now,
  };
  if (!config.enabled) {
    if (current) {
      base.lastScheduledAt = current.lastScheduledAt ?? null;
      base.lastCatchUpAt = current.lastCatchUpAt ?? null;
      base.missedIntervals = current.missedIntervals ?? 0;
    }
    return { state: base, due: false, scheduledFor: null, missedIntervals: 0, scheduleLagMs: 0 };
  }
  if (current?.intervalMs !== config.intervalMs) {
    base.nextScheduledAt = new Date(nowMs + config.intervalMs).toISOString();
    return { state: base, due: false, scheduledFor: null, missedIntervals: 0, scheduleLagMs: 0 };
  }
  const state: RankingMonitorScheduleState = { ...base, ...structuredClone(current), intervalMs: config.intervalMs, updatedAt: now };
  if (validTimestamp(state.pendingScheduledFor)) {
    const lag = Math.max(0, nowMs - Date.parse(state.pendingScheduledFor));
    return { state, due: true, scheduledFor: state.pendingScheduledFor, missedIntervals: Math.max(1, state.missedIntervals), scheduleLagMs: lag };
  }
  if (!validTimestamp(state.nextScheduledAt)) {
    state.nextScheduledAt = new Date(nowMs + config.intervalMs).toISOString();
    return { state, due: false, scheduledFor: null, missedIntervals: 0, scheduleLagMs: 0 };
  }
  const dueMs = Date.parse(state.nextScheduledAt);
  if (dueMs > nowMs) return { state, due: false, scheduledFor: null, missedIntervals: 0, scheduleLagMs: 0 };
  const missedIntervals = Math.floor((nowMs - dueMs) / config.intervalMs) + 1;
  const scheduledFor = state.nextScheduledAt;
  state.pendingScheduledFor = scheduledFor;
  state.nextScheduledAt = new Date(dueMs + missedIntervals * config.intervalMs).toISOString();
  state.missedIntervals = missedIntervals;
  return { state, due: true, scheduledFor, missedIntervals, scheduleLagMs: Math.max(0, nowMs - dueMs) };
}

export function completeRankingMonitorSchedule(current: RankingMonitorScheduleState, scheduledFor: string, finishedAt: string, catchUp: boolean): RankingMonitorScheduleState {
  return { ...structuredClone(current), pendingScheduledFor: null, lastScheduledAt: scheduledFor, lastCatchUpAt: catchUp ? finishedAt : current.lastCatchUpAt, updatedAt: finishedAt };
}

export class RankingMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private active = false;
  private sequence = 0;
  private readonly receipts: RankingMonitorReceipt[] = [];
  private schedule: RankingMonitorScheduleState | null;
  readonly config: RankingMonitorConfig;
  private readonly runner: RankingSnapshotRunner;
  private readonly now: () => string;
  private readonly onReceipt?: RankingMonitorPersistence["onReceipt"];
  private readonly onSchedule?: RankingMonitorPersistence["onSchedule"];

  constructor(config: RankingMonitorConfig, runner: RankingSnapshotRunner, now: () => string = () => new Date().toISOString(), persistence: RankingMonitorPersistence = {}) {
    if (!config.monitorId.trim() || !config.scopeId.trim()) throw new Error("INVALID_MONITOR_IDENTITY");
    if (!Number.isInteger(config.intervalMs) || config.intervalMs < 1_000) throw new Error("INVALID_MONITOR_INTERVAL");
    this.config = config;
    this.runner = runner;
    this.now = now;
    this.receipts.push(...structuredClone(persistence.initialReceipts ?? []).slice(-200));
    this.sequence = this.receipts.reduce((maximum, receipt) => {
      const match = receipt.runId.match(/:(\d+)$/);
      return match ? Math.max(maximum, Number(match[1])) : maximum;
    }, 0);
    this.schedule = persistence.initialSchedule ? structuredClone(persistence.initialSchedule) : null;
    this.onReceipt = persistence.onReceipt;
    this.onSchedule = persistence.onSchedule;
  }

  start(): void {
    if (this.started) return;
    if (!this.config.enabled) {
      this.schedule = reconcileRankingMonitorSchedule(this.config, this.schedule, this.now()).state;
      void this.persistSchedule();
      return;
    }
    this.started = true;
    void this.scheduleCycle(true);
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  isRunning(): boolean { return this.started; }
  isCaptureActive(): boolean { return this.active; }
  listReceipts(): RankingMonitorReceipt[] { return structuredClone(this.receipts); }
  getSchedule(): RankingMonitorScheduleState | null { return this.schedule ? structuredClone(this.schedule) : null; }

  private async persistSchedule(): Promise<void> {
    if (this.schedule) await this.onSchedule?.(structuredClone(this.schedule));
  }

  private armNext(): void {
    if (!this.started || !this.schedule?.nextScheduledAt) return;
    const delay = Math.max(0, Date.parse(this.schedule.nextScheduledAt) - Date.parse(this.now()));
    this.timer = setTimeout(() => { this.timer = null; void this.scheduleCycle(false); }, Math.min(delay, 2_147_483_647));
    this.timer.unref?.();
  }

  private async scheduleCycle(startup: boolean): Promise<void> {
    if (!this.started) return;
    const reconciled = reconcileRankingMonitorSchedule(this.config, this.schedule, this.now());
    this.schedule = reconciled.state;
    await this.persistSchedule();
    if (!this.started) return;
    if (!reconciled.due || !reconciled.scheduledFor) { this.armNext(); return; }
    await this.run("SCHEDULED", { scheduledFor: reconciled.scheduledFor, catchUp: startup, missedIntervals: reconciled.missedIntervals, scheduleLagMs: reconciled.scheduleLagMs });
    this.schedule = completeRankingMonitorSchedule(this.schedule, reconciled.scheduledFor, this.now(), startup);
    await this.persistSchedule();
    if (this.started) this.armNext();
  }

  private async record(receipt: RankingMonitorReceipt): Promise<RankingMonitorReceipt> {
    this.receipts.push(receipt);
    if (this.receipts.length > 200) this.receipts.splice(0, this.receipts.length - 200);
    await this.onReceipt?.(structuredClone(receipt));
    return structuredClone(receipt);
  }

  async run(trigger: "MANUAL" | "SCHEDULED" = "MANUAL", scheduleContext: Pick<RankingMonitorReceipt, "scheduledFor" | "catchUp" | "missedIntervals" | "scheduleLagMs"> = {}): Promise<RankingMonitorReceipt> {
    const startedAt = this.now();
    const runId = `${this.config.monitorId}:${String(++this.sequence).padStart(6, "0")}`;
    const scheduled = trigger === "SCHEDULED" ? scheduleContext : {};
    if (this.active) {
      return this.record({ runId, monitorId: this.config.monitorId, trigger, startedAt, finishedAt: this.now(), status: "SKIPPED_OVERLAP", snapshotId: null, browserTaskId: null, errorCode: "PREVIOUS_CAPTURE_ACTIVE", ...scheduled });
    }
    this.active = true;
    try {
      const result = await this.runner.capture(this.config.scopeId);
      const dispatched = result.kind === "BROWSER_TASK";
      return this.record({ runId, monitorId: this.config.monitorId, trigger, startedAt, finishedAt: this.now(), status: dispatched ? "DISPATCHED" : "SUCCEEDED", snapshotId: dispatched ? null : result.snapshotId, browserTaskId: dispatched ? result.browserTaskId : null, errorCode: null, ...scheduled });
    } catch (error) {
      return this.record({ runId, monitorId: this.config.monitorId, trigger, startedAt, finishedAt: this.now(), status: "FAILED", snapshotId: null, browserTaskId: null, errorCode: error instanceof Error ? error.message : "CAPTURE_FAILED", ...scheduled });
    } finally {
      this.active = false;
    }
  }
}
