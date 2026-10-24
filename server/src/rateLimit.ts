import type { MiddlewareHandler } from "hono";

export interface RateLimitOptions {
  /** Max burst size. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
  /** How to identify the caller (usually client IP). */
  key(c: Parameters<MiddlewareHandler>[0]): string;
}

/**
 * In-memory token bucket per key. Good enough for one instance; move to
 * Redis (or the load balancer / WAF) when we run more than one.
 */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const buckets = new Map<string, { tokens: number; at: number }>();
  let lastSweep = Date.now();

  return async (c, next) => {
    const now = Date.now();
    // Forget idle callers now and then so the map doesn't grow forever.
    if (now - lastSweep > 60_000) {
      const idleMs = (opts.capacity / opts.refillPerSec) * 1000;
      for (const [k, b] of buckets) if (now - b.at > idleMs) buckets.delete(k);
      lastSweep = now;
    }

    const key = opts.key(c);
    const b = buckets.get(key) ?? { tokens: opts.capacity, at: now };
    b.tokens = Math.min(opts.capacity, b.tokens + ((now - b.at) / 1000) * opts.refillPerSec);
    b.at = now;
    buckets.set(key, b);

    if (b.tokens < 1) {
      c.header("Retry-After", String(Math.ceil((1 - b.tokens) / opts.refillPerSec)));
      return c.json({ ok: false, error: "too many requests" }, 429);
    }
    b.tokens -= 1;
    await next();
  };
}
