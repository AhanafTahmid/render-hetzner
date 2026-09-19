/**
 * GENERATED — do not edit.
 *
 * Written by shortshero/scripts/sync-facetrack.mjs from lib/oomVictim.ts.
 * Change the app's copy and re-run:
 *
 *   pnpm sync:facetrack     (then rebuild and redeploy the render server)
 */
/**
 * Volunteer a child process as the kernel's first choice when memory runs out.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * When the container hits its memory cap, the kernel kills whichever process
 * scores highest, and the score is mostly size. On 2026-09-15 that was usually
 * an ffmpeg — and on 09:56:13 it was `next-server` itself, because the fattest
 * ffmpeg had just been killed and the web server was the biggest thing left.
 * Killing an ffmpeg costs one clip one retry. Killing the web server is every
 * in-flight Inngest step answering "Your server returned HTTP 502 before the SDK
 * responded", i.e. the failed runs this codebase keeps chasing.
 *
 * `oom_score_adj = 1000` makes a child the victim whenever it is alive,
 * regardless of size. Raising a score needs no privilege; lowering one does,
 * which is why this marks the children rather than protecting the parent. A
 * child's own children inherit the value at fork, so marking yt-dlp covers the
 * ffmpeg it launches for ranged downloads.
 *
 * Best effort by design: there is no /proc on macOS, and a process that has
 * already exited has nothing to mark. Neither is a reason to fail the work.
 */

import fs from "fs";
import type { ChildProcess } from "child_process";

export function preferOomKill(child: ChildProcess): void {
  if (!child.pid || process.platform !== "linux") return;
  try {
    fs.writeFileSync(`/proc/${child.pid}/oom_score_adj`, "1000");
  } catch {
    // Exited already, or /proc is read-only here. The child runs either way.
  }
}

/** Readable reason for a child's exit, naming the signal when there was no code. */
export function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `exited with code ${code}`;
  if (signal === "SIGKILL") return "was killed (SIGKILL — almost always the container running out of memory)";
  return `was killed by ${signal ?? "an unknown signal"}`;
}

/**
 * A child stopped by `watchRss` for outgrowing its budget.
 *
 * Its own type so callers can tell "this plan eats memory" apart from a flaky
 * failure: re-running the same command with the same input grows the same way,
 * so it is a reason to change plans, never to retry.
 */
export class MemoryBudgetError extends Error {
  readonly peakBytes: number;
  constructor(label: string, peakBytes: number, budgetBytes: number) {
    super(
      `${label} exceeded its ${Math.round(budgetBytes / 1048576)} MB memory budget ` +
      `(reached ${Math.round(peakBytes / 1048576)} MB) and was stopped before it could take the container down`
    );
    this.name = "MemoryBudgetError";
    this.peakBytes = peakBytes;
  }
}

/** How often a watched child's resident memory is read. */
const RSS_POLL_MS = 500;

/**
 * Kill `child` if its resident memory passes `budgetBytes`.
 *
 * `oom_score_adj` decides WHO dies when the container runs out; this decides
 * that it never runs out because of one process. The distinction mattered on
 * 2026-09-15: seven kernel OOM kills, five of them the same ffmpeg command at
 * ~1.6 GB, retried every ~40 s into the same wall — while every real clip from
 * that day, replayed in the production image with the production binary, peaked
 * at 387–550 MB. Something occasionally makes one encode run away, and until
 * it is caught in the act the container needs a ceiling that does not depend
 * on knowing what.
 *
 * `onExceed` is called once, before the kill, so the caller can log the full
 * command — the one piece of evidence the kernel never records.
 *
 * Linux only (reads /proc). Elsewhere it watches nothing and costs nothing.
 */
export function watchRss(
  child: ChildProcess,
  budgetBytes: number,
  onExceed?: (rssBytes: number) => void
): { stop: () => void; exceeded: () => number | null } {
  let over: number | null = null;
  if (!child.pid || process.platform !== "linux") {
    return { stop: () => {}, exceeded: () => over };
  }
  const statusPath = `/proc/${child.pid}/status`;
  const timer = setInterval(() => {
    let rss: number;
    try {
      const m = /VmRSS:\s+(\d+)\s+kB/.exec(fs.readFileSync(statusPath, "utf8"));
      if (!m) return;
      rss = Number(m[1]) * 1024;
    } catch {
      clearInterval(timer); // exited between polls
      return;
    }
    if (rss <= budgetBytes || over !== null) return;
    over = rss;
    clearInterval(timer);
    try { onExceed?.(rss); } catch {}
    child.kill("SIGKILL");
  }, RSS_POLL_MS);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  child.once("exit", stop);
  return { stop, exceeded: () => over };
}
