/**
 * Stage B (Execution & Review) activity widget.
 *
 * Why this exists: the plain string widget only changed when a new ACP event
 * arrived. During a long `agent_thought_chunk` phase the line stayed
 * byte-identical for minutes, so a healthy Executor/Reviewer turn looked
 * indistinguishable from a hung one.
 *
 * The spinner intentionally reuses Pi's own working-loader defaults
 * (`@earendil-works/pi-tui` `Loader`, also used by Pi's `WorkingStatusIndicator`):
 * the same ten frames every 80 ms, spinner painted with theme `accent` and text
 * with `muted` so the widget reads like the rest of Pi.
 *
 * Liveness is derived from the real ACP event stream, not from the timer:
 * - `N evt/s` while events keep arriving,
 * - the spinner stops and the line switches to a warning once no ACP event has
 *   arrived for `STALL_AFTER_MS`, so "thinking" and "stuck" look different.
 */
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatDurationShort } from "./pause.js";
import type { StageBStatusEvent } from "./types.js";

/**
 * Identical to Pi's working-loader frames (`@earendil-works/pi-tui` `Loader`).
 * Keep in sync so the Stage B spinner matches Pi's built-in working animation.
 */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const SPINNER_INTERVAL_MS = 80;

/** ACP silence after which a nominally running turn is shown as stalled. */
export const STALL_AFTER_MS = 20_000;

/** Remaining whole-run budget under which the header switches to a warning color. */
export const BUDGET_WARN_MS = 5 * 60 * 1000;

/** Rolling window for the `evt/s` readout. */
const RATE_WINDOW_MS = 1_000;

export type StatusWidgetRole = "executor" | "reviewer";
export type StatusWidgetTheme = Pick<Theme, "fg">;

export interface StageBActivitySnapshot {
  header: string;
  primary: string;
  message: string;
  running: boolean;
  /** Timestamp of the most recent ACP event; 0 before the first one. */
  lastEventAt: number;
  /** ACP events in the last second (real stream liveness, not the spinner timer). */
  eventsInWindow: number;
  /** Whole-run watchdog budget; absent for no-timeout runs. */
  budget?: { startedAt: number; timeoutMs: number };
}

/** Spinner frame for a point in time; wall-clock based so re-renders stay in sync. */
export function frameAt(now: number): string {
  return SPINNER_FRAMES[Math.floor(now / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]!;
}

/** Milliseconds since the last ACP event; 0 when not running or before the first event. */
export function stalledFor(snapshot: StageBActivitySnapshot, now: number): number {
  if (!snapshot.running || snapshot.lastEventAt <= 0) return 0;
  return Math.max(0, now - snapshot.lastEventAt);
}

/**
 * Remaining whole-run budget for the header line. Hidden when no watchdog is
 * configured or the run is no longer live, so a paused/completed widget keeps
 * its final informative line instead of a stale countdown.
 */
function budgetSuffix(snapshot: StageBActivitySnapshot, theme: StatusWidgetTheme, now: number): string {
  if (!snapshot.running || !snapshot.budget) return "";
  const remaining = snapshot.budget.timeoutMs - (now - snapshot.budget.startedAt);
  const label = remaining <= 0 ? "timeout now" : `${formatDurationShort(remaining)} left`;
  return remaining <= BUDGET_WARN_MS
    ? ` ${theme.fg("warning", `· ${label}`)}`
    : ` ${theme.fg("dim", `· ${label}`)}`;
}

export function formatActivityLines(
  snapshot: StageBActivitySnapshot,
  theme: StatusWidgetTheme,
  width: number,
  now: number,
): string[] {
  if (!snapshot.header && !snapshot.primary) return [];
  const lines = [truncateToWidth(` ${snapshot.header}${budgetSuffix(snapshot, theme, now)}`, width, "")];
  const silence = stalledFor(snapshot, now);
  if (silence >= STALL_AFTER_MS) {
    const seconds = Math.round(silence / 1_000);
    lines.push(
      truncateToWidth(
        ` ${theme.fg("warning", "⚠")} ${theme.fg("warning", snapshot.primary)} ${theme.fg("warning", `· no ACP events for ${seconds}s`)}`,
        width,
        "",
      ),
    );
  } else if (snapshot.running) {
    const rate = snapshot.eventsInWindow > 0 ? theme.fg("dim", ` · ${snapshot.eventsInWindow} evt/s`) : "";
    lines.push(
      truncateToWidth(
        ` ${theme.fg("accent", frameAt(now))} ${theme.fg("muted", snapshot.primary)}${rate}`,
        width,
        "",
      ),
    );
  } else {
    lines.push(truncateToWidth(`   ${theme.fg("muted", snapshot.primary)}`, width, ""));
  }
  if (snapshot.message) lines.push(truncateToWidth(` ${theme.fg("muted", snapshot.message)}`, width, ""));
  return lines;
}

/**
 * Mutable widget state, separate from the render component so the extension can
 * update it even if the interactive host creates the component lazily.
 */
export class StageBActivityModel {
  private header = "";
  private primary = "";
  private message = "";
  private running = false;
  private lastEventAt = 0;
  private budget: { startedAt: number; timeoutMs: number } | undefined;
  private readonly eventTimes: number[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly clock: () => number = Date.now) {}

  now(): number {
    return this.clock();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** A live ACP stream event: show the role/event line and refresh liveness. */
  startLive(runId: string, role: StatusWidgetRole, event: string): void {
    const now = this.clock();
    this.header = `Execution & Review · ${runId}`;
    this.primary = `${role} · ${event}`;
    this.message = "";
    this.running = true;
    this.lastEventAt = now;
    this.eventTimes.push(now);
    this.prune(now);
    this.notify();
  }

  /** A workflow status transition: phase/round header plus per-role states. */
  applyStatus(event: StageBStatusEvent): void {
    this.header = `Execution & Review · ${event.phase_id} · round ${event.round}`;
    this.primary = `Executor ${event.executor_status} · Reviewer ${event.reviewer_status}`;
    this.message = event.message;
    this.running = event.executor_status === "running" || event.reviewer_status === "running";
    this.notify();
  }

  /** Stop animating (pause/completion/teardown) without discarding the last line. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.notify();
  }

  /** Configure the whole-run watchdog budget; `timeoutMs <= 0` disables the readout. */
  setBudget(startedAt: number, timeoutMs: number): void {
    this.budget = timeoutMs > 0 ? { startedAt, timeoutMs } : undefined;
    this.notify();
  }

  snapshot(now: number = this.clock()): StageBActivitySnapshot {
    this.prune(now);
    return {
      header: this.header,
      primary: this.primary,
      message: this.message,
      running: this.running,
      lastEventAt: this.lastEventAt,
      eventsInWindow: this.eventTimes.length,
      ...(this.budget ? { budget: this.budget } : {}),
    };
  }

  private prune(now: number): void {
    const cutoff = now - RATE_WINDOW_MS;
    let first = 0;
    while (first < this.eventTimes.length && this.eventTimes[first]! < cutoff) first += 1;
    if (first > 0) this.eventTimes.splice(0, first);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * Render component for {@link StageBActivityModel}. Owns the 80 ms render timer
 * while a turn is live, and stops it once the stream stalls or the run stops.
 */
export class StageBActivityWidget implements Component {
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly tui: TUI,
    private readonly theme: StatusWidgetTheme,
    private readonly model: StageBActivityModel,
  ) {
    this.unsubscribe = model.subscribe(() => this.refresh());
    this.refresh();
  }

  get spinning(): boolean {
    return this.timer !== undefined;
  }

  /** Re-evaluate spin/stall state and request a render. Timer callback and model changes both land here. */
  refresh(): void {
    if (this.disposed) return;
    const now = this.model.now();
    const snapshot = this.model.snapshot(now);
    const shouldSpin = snapshot.running && stalledFor(snapshot, now) < STALL_AFTER_MS;
    if (shouldSpin && this.timer === undefined) {
      this.timer = setInterval(() => this.refresh(), SPINNER_INTERVAL_MS);
    } else if (!shouldSpin && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const now = this.model.now();
    return formatActivityLines(this.model.snapshot(now), this.theme, width, now);
  }

  invalidate(): void {
    // Colors are applied on every render; nothing cached to invalidate.
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.unsubscribe();
  }
}
