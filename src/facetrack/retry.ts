/**
 * GENERATED — do not edit.
 *
 * Written by shortshero/scripts/sync-facetrack.mjs from lib/retry.ts.
 * Change the app's copy and re-run:
 *
 *   pnpm sync:facetrack     (then rebuild and redeploy the render server)
 */
/**
 * Retry with exponential backoff, for work that fails transiently.
 *
 * Face tracking is the motivating case: a single clip's crop can die on a
 * BlazeFace weight fetch that timed out, an ffmpeg pipe that closed early, or an
 * R2 PUT that got a 500 — none of which say anything about the clip itself. One
 * attempt turned every one of those into a permanent "re-crop failed" card the
 * user had to click, when simply doing it again would have worked.
 *
 * Deliberately dumb: no jitter, no circuit breaker, no error classification.
 * The call sites here run a handful of attempts against their own machine or
 * one storage bucket, so the failure modes that classification would protect
 * against (thundering herd, hammering a down dependency) do not apply.
 */

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Delay before attempt 2; doubles each time after. */
  baseDelayMs?: number;
  /** Ceiling on the backoff, so a long chain does not stall for minutes. */
  maxDelayMs?: number;
  /** Prefix for the retry log lines, e.g. "facetrack detect abc123". */
  label?: string;
  /** Return false to stop retrying a failure that will never succeed. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn` until it resolves or the attempts run out. Rethrows the LAST error,
 * so the caller's log shows the failure that actually ended the chain rather
 * than the first one.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const baseDelayMs = opts.baseDelayMs ?? 1_500;
  const maxDelayMs = opts.maxDelayMs ?? 20_000;
  const label = opts.label ?? "task";

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);

      if (opts.shouldRetry && !opts.shouldRetry(err, attempt)) {
        console.error(`[retry] ${label}: not retryable — ${msg}`);
        throw err;
      }
      if (attempt >= attempts) {
        console.error(`[retry] ${label}: failed after ${attempts} attempt(s) — ${msg}`);
        throw err;
      }

      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      console.warn(
        `[retry] ${label}: attempt ${attempt}/${attempts} failed (${msg}) — retrying in ${delay}ms`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * `withRetry` that resolves to `null` instead of throwing when every attempt
 * fails. For best-effort work where the caller has a fallback path and an
 * exception would just be caught and discarded one line later.
 */
export async function tryWithRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {}
): Promise<T | null> {
  try {
    return await withRetry(fn, opts);
  } catch {
    return null;
  }
}
