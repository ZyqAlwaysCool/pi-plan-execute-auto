/**
 * Stage B (Execution & Review) activity widget.
 *
 * Why this exists: the plain string widget only changed when a new ACP event
 * arrived. During a long `agent_thought_chunk` phase the line stayed
 * byte-identical for minutes, so a healthy Executor/Reviewer turn looked
 * indistinguishable from a hung one.
 *
 * Layout contract (stable 3-4 lines, each line has exactly one writer):
 * 1. header        — run id, phase progress `2/4 phases`, whole-run budget
 * 2. phase list    — full phase names with ✓/▶/⏸/○ markers and the current round
 * 3. live activity — spinner belongs here only, plus real ACP `evt/s`
 * 4. message       — status text; on a checkpoint pause, cause + resume command
 *
 * `startLive()` must never clear the header, phase list, or message: stream
 * events and workflow status events are independent sources that used to
 * overwrite each other.
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
import { stripTerminalSequences, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatDurationShort, formatPauseHeadline } from "./pause.js";
import type { PauseRecord, StageBPlanSnapshot, StageBStatusEvent } from "./types.js";

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

/** Phase checklist marker/separator contract shared by the widget and static summaries. */
export const CHECKLIST_SEPARATOR = " · ";
export const CHECKLIST_MARKERS = { completed: "✓", current: "▶", paused: "⏸", pending: "○" } as const;
const MIN_PHASE_NAME_WIDTH = 6;

export type StatusWidgetRole = "executor" | "reviewer";
export type StatusWidgetTheme = Pick<Theme, "fg">;

export type ChecklistPartKind = "completed" | "current" | "pending";
export interface ChecklistPart {
  /** Plain text including the marker; color is applied by the caller. */
  text: string;
  kind: ChecklistPartKind;
}

export interface StageBActivitySnapshot {
  runId: string;
  /** Live plan progress; absent before any status/plan event. */
  plan?: StageBPlanSnapshot;
  /** Latest phase id from status events; fallback when no plan snapshot exists. */
  phaseId: string;
  /** Latest round from status events. */
  round: number;
  running: boolean;
  /** Latest ACP stream event; the spinner belongs to this line. */
  live?: { role: StatusWidgetRole; event: string };
  /** Latest status or pause message. */
  message: string;
  /** Present when the run stopped on a checkpoint pause. */
  pause?: PauseRecord;
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
 * Width-aware phase checklist layout.
 *
 * Full phase names are the default. When the full line does not fit, names are
 * truncated proportionally (the current phase keeps the remainder so it stays
 * readable); when even that is impossible the list degrades to a single
 * `▶ 2/4 phase-2-render` entry. All measurements use terminal cell width, so
 * CJK phase names truncate on character boundaries instead of byte counts.
 */
export function layoutPlanChecklist(
  plan: StageBPlanSnapshot,
  width: number,
  options?: { round?: number; paused?: boolean },
): ChecklistPart[] {
  const total = plan.phase_ids.length;
  const available = width - 1; // leading space
  if (total === 0 || available <= 0) return [];
  const round = options?.round;
  const paused = options?.paused ?? false;
  const parts = plan.phase_ids.map((id, index) => {
    const status = plan.phase_statuses[index] ?? "pending";
    const current = index === plan.current_index;
    const kind: ChecklistPartKind = status === "completed" ? "completed" : current ? "current" : "pending";
    const marker = kind === "completed"
      ? CHECKLIST_MARKERS.completed
      : current
        ? (paused ? CHECKLIST_MARKERS.paused : CHECKLIST_MARKERS.current)
        : CHECKLIST_MARKERS.pending;
    const suffix = current && plan.review_round_limit > 0 && round !== undefined && round > 0
      ? ` (r${round}/${plan.review_round_limit})`
      : "";
    return { id, marker, suffix, kind };
  });

  const full = parts.map((part) => `${part.marker} ${part.id}${part.suffix}`).join(CHECKLIST_SEPARATOR);
  if (visibleWidth(full) <= available) {
    return parts.map((part) => ({ text: `${part.marker} ${part.id}${part.suffix}`, kind: part.kind }));
  }

  const separatorWidth = visibleWidth(CHECKLIST_SEPARATOR);
  const fixedWidth = parts.reduce((sum, part) => sum + visibleWidth(part.marker) + 1 + visibleWidth(part.suffix), 0) +
    separatorWidth * (total - 1);
  const nameBudgetTotal = available - fixedWidth;
  const currentIndex = parts.findIndex((part) => part.kind === "current");

  if (nameBudgetTotal >= total * MIN_PHASE_NAME_WIDTH) {
    const equalShare = Math.floor(nameBudgetTotal / total);
    const shortIndices: number[] = [];
    const longIndices: number[] = [];
    parts.forEach((part, index) => (visibleWidth(part.id) <= equalShare ? shortIndices : longIndices).push(index));
    const shortWidth = shortIndices.reduce((sum, index) => sum + visibleWidth(parts[index]!.id), 0);
    const longSpace = nameBudgetTotal - shortWidth;
    const longBase = longIndices.length > 0 ? Math.floor(longSpace / longIndices.length) : 0;
    const longRemainder = longIndices.length > 0 ? longSpace - longBase * longIndices.length : 0;
    return parts.map((part, index) => {
      if (shortIndices.includes(index)) return { text: `${part.marker} ${part.id}${part.suffix}`, kind: part.kind };
      const budget = Math.max(2, longBase + (index === currentIndex ? longRemainder : 0));
      return { text: `${part.marker} ${stripTerminalSequences(truncateToWidth(part.id, budget, "…"))}${part.suffix}`, kind: part.kind };
    });
  }

  const focusIndex = currentIndex >= 0 ? currentIndex : total - 1;
  const focus = parts[focusIndex]!;
  return [{
    text: stripTerminalSequences(truncateToWidth(`${focus.marker} ${focusIndex + 1}/${total} ${focus.id}${focus.suffix}`, available, "…")),
    kind: focus.kind,
  }];
}

/** Plain checklist text for static summaries; see {@link layoutPlanChecklist}. */
export function formatPlanChecklist(
  plan: StageBPlanSnapshot,
  width: number,
  options?: { round?: number; paused?: boolean },
): string {
  return layoutPlanChecklist(plan, width, options).map((part) => part.text).join(CHECKLIST_SEPARATOR);
}

export function formatActivityLines(
  snapshot: StageBActivitySnapshot,
  theme: StatusWidgetTheme,
  width: number,
  now: number,
): string[] {
  if (!snapshot.runId && !snapshot.plan && !snapshot.phaseId) return [];
  const lines = [headerLine(snapshot, theme, width, now)];
  const checklist = checklistLine(snapshot, theme, width);
  if (checklist) lines.push(checklist);
  if (snapshot.pause) {
    lines.push(truncateToWidth(` ${theme.fg("warning", formatPauseHeadline(snapshot.pause))}`, width, ""));
    lines.push(truncateToWidth(
      snapshot.pause.resumable
        ? ` ${theme.fg("muted", `Resume: /plan-execute resume ${snapshot.runId}`)}`
        : ` ${theme.fg("error", "Resume refused; repair the reported evidence first.")}`,
      width,
      "",
    ));
    return lines;
  }
  const live = liveLine(snapshot, theme, width, now);
  if (live) lines.push(live);
  if (snapshot.message) lines.push(truncateToWidth(` ${theme.fg("muted", snapshot.message)}`, width, ""));
  return lines;
}

function headerLine(snapshot: StageBActivitySnapshot, theme: StatusWidgetTheme, width: number, now: number): string {
  const label = snapshot.runId ? `Execution & Review · ${snapshot.runId}` : "Execution & Review";
  const segments = [theme.fg("muted", label)];
  const complete = Boolean(snapshot.plan && snapshot.plan.phase_statuses.every((status) => status === "completed"));
  if (snapshot.plan) {
    const completed = snapshot.plan.phase_statuses.filter((status) => status === "completed").length;
    segments.push(theme.fg("dim", `${completed}/${snapshot.plan.phase_ids.length} phases`));
  }
  if (snapshot.pause) segments.push(theme.fg("warning", "paused"));
  else if (complete) segments.push(theme.fg("success", "complete"));
  const budget = budgetSuffix(snapshot, theme, now);
  if (budget) segments.push(budget);
  return truncateToWidth(` ${segments.join(theme.fg("dim", " · "))}`, width, "");
}

function checklistLine(snapshot: StageBActivitySnapshot, theme: StatusWidgetTheme, width: number): string | undefined {
  if (!snapshot.plan || snapshot.plan.phase_ids.length === 0) return undefined;
  const parts = layoutPlanChecklist(snapshot.plan, width, {
    ...(snapshot.round > 0 ? { round: snapshot.round } : {}),
    paused: Boolean(snapshot.pause),
  });
  if (parts.length === 0) return undefined;
  const body = parts.map((part) => {
    if (part.kind === "completed") return theme.fg("success", part.text);
    if (part.kind === "current") return theme.fg("accent", part.text);
    return theme.fg("dim", part.text);
  }).join(CHECKLIST_SEPARATOR);
  return truncateToWidth(` ${body}`, width, "");
}

function liveLine(snapshot: StageBActivitySnapshot, theme: StatusWidgetTheme, width: number, now: number): string | undefined {
  if (!snapshot.live) return undefined;
  const label = `${snapshot.live.role} · ${snapshot.live.event}`;
  const silence = stalledFor(snapshot, now);
  if (snapshot.running && silence >= STALL_AFTER_MS) {
    const seconds = Math.round(silence / 1_000);
    return truncateToWidth(
      ` ${theme.fg("warning", "⚠")} ${theme.fg("warning", label)} ${theme.fg("warning", `· no ACP events for ${seconds}s`)}`,
      width,
      "",
    );
  }
  if (snapshot.running) {
    const rate = snapshot.eventsInWindow > 0 ? theme.fg("dim", ` · ${snapshot.eventsInWindow} evt/s`) : "";
    return truncateToWidth(` ${theme.fg("accent", frameAt(now))} ${theme.fg("muted", label)}${rate}`, width, "");
  }
  return truncateToWidth(`   ${theme.fg("muted", label)}`, width, "");
}

/**
 * Remaining whole-run budget for the header line. Hidden when no watchdog is
 * configured or the run is no longer live, so a paused/completed widget keeps
 * its final informative line instead of a stale countdown.
 */
function budgetSuffix(snapshot: StageBActivitySnapshot, theme: StatusWidgetTheme, now: number): string | undefined {
  if (!snapshot.running || !snapshot.budget) return undefined;
  const remaining = snapshot.budget.timeoutMs - (now - snapshot.budget.startedAt);
  const label = remaining <= 0 ? "timeout now" : `${formatDurationShort(remaining)} left`;
  return remaining <= BUDGET_WARN_MS ? theme.fg("warning", label) : theme.fg("dim", label);
}

/**
 * Mutable widget state, separate from the render component so the extension can
 * update it even if the interactive host creates the component lazily.
 */
export class StageBActivityModel {
  private runId = "";
  private plan: StageBPlanSnapshot | undefined;
  private phaseId = "";
  private round = 0;
  private running = false;
  private stopped = false;
  private live: { role: StatusWidgetRole; event: string } | undefined;
  private message = "";
  private pause: PauseRecord | undefined;
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

  /** A live ACP stream event: refresh only the live line and liveness counters. */
  startLive(runId: string, role: StatusWidgetRole, event: string): void {
    this.runId = runId;
    this.live = { role, event };
    const now = this.clock();
    this.lastEventAt = now;
    this.eventTimes.push(now);
    this.prune(now);
    if (!this.stopped) this.running = true;
    this.notify();
  }

  /** Bind the run identity before the first ACP event so the header is complete. */
  setRunId(runId: string): void {
    this.runId = runId;
    this.notify();
  }

  /** A workflow status transition: plan progress, phase/round header, and message. */
  applyStatus(event: StageBStatusEvent): void {
    this.phaseId = event.phase_id;
    this.round = event.round;
    if (event.plan) this.plan = event.plan;
    this.message = event.message;
    this.pause = event.pause;
    if (event.pause) {
      this.stopped = true;
      this.running = false;
    } else {
      this.running = event.executor_status === "running" || event.reviewer_status === "running";
    }
    this.notify();
  }

  /** Initial plan snapshot so a fresh/resumed run shows `N/M` before the first event. */
  setPlan(plan: StageBPlanSnapshot): void {
    this.plan = plan;
    this.notify();
  }

  /** Stop animating (pause/completion/teardown) without discarding the last lines. */
  stop(): void {
    if (!this.running && this.stopped) return;
    this.running = false;
    this.stopped = true;
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
      runId: this.runId,
      ...(this.plan ? { plan: this.plan } : {}),
      phaseId: this.phaseId,
      round: this.round,
      running: this.running,
      ...(this.live ? { live: this.live } : {}),
      message: this.message,
      ...(this.pause ? { pause: this.pause } : {}),
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
