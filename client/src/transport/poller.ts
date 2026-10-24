import type { TableEvent } from "@tabletop/shared";
import { fetchEvents } from "./api";

/** Poll timing. Fast right after activity, slower when idle, very slow when hidden. */
export const POLL = {
  activeMs: 1000,
  idleMaxMs: 5000,
  backoff: 1.5,
  hiddenMs: 30000,
  errorMs: 5000,
};

export type PollStatus = "ok" | "offline";

export interface PollerOptions {
  session: string;
  /** Seq of the last event the caller has applied. */
  getSeq(): number;
  onEvents(events: TableEvent[]): void;
  onStatus?(status: PollStatus): void;
}

export class Poller {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private interval = POLL.activeMs;
  private etag: string | null = null;
  private inFlight = false;
  private again = false;
  private stopped = true;

  constructor(private opts: PollerOptions) {}

  start(): void {
    this.stopped = false;
    document.addEventListener("visibilitychange", this.onVisibility);
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  /** Something just happened (e.g. we posted an action): poll now and stay fast for a bit. */
  nudge(): void {
    this.interval = POLL.activeMs;
    void this.poll();
  }

  private onVisibility = () => {
    if (document.visibilityState === "visible") this.nudge();
  };

  private async poll(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) {
      this.again = true;
      return;
    }
    clearTimeout(this.timer);
    this.inFlight = true;
    let delay: number;

    try {
      const result = await fetchEvents(this.opts.session, this.opts.getSeq(), this.etag);
      this.opts.onStatus?.("ok");
      if (result.changed) {
        this.etag = result.etag;
        if (result.events.length > 0) this.opts.onEvents(result.events);
      }
      const behind = result.changed && this.opts.getSeq() < result.latestSeq;
      if (result.changed && result.events.length > 0) this.interval = POLL.activeMs;
      else this.interval = Math.min(this.interval * POLL.backoff, POLL.idleMaxMs);
      // More pages waiting: fetch them right away.
      delay = behind ? 0 : this.interval;
    } catch {
      this.opts.onStatus?.("offline");
      delay = POLL.errorMs;
    } finally {
      this.inFlight = false;
    }

    if (this.again) {
      this.again = false;
      delay = 0;
    }
    if (document.visibilityState === "hidden") delay = Math.max(delay, POLL.hiddenMs);
    if (!this.stopped) this.timer = setTimeout(() => void this.poll(), delay);
  }
}
