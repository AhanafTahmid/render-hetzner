/**
 * A pool of long-lived face-tracking worker processes with a FIFO queue.
 *
 * ── How many workers ────────────────────────────────────────────────────────
 *
 * Measured 2026-09-19 on the idle CX53 (16 vCPU), 16 clips of 40 s each,
 * one process per worker:
 *
 *      1 worker   132.5 s   7.25 clips/min   1.00x
 *      2 workers   96.5 s   9.94 clips/min   1.37x
 *      4 workers   72.4 s  13.26 clips/min   1.83x
 *      6 workers   68.7 s  13.98 clips/min   1.93x
 *      8 workers   61.9 s  15.51 clips/min   2.14x   <- default
 *     12 workers   62.5 s  15.37 clips/min   2.12x
 *     16 workers   59.0 s  16.26 clips/min   2.24x
 *
 * Sixteen workers on sixteen cores buys 2.24x, not 16x, because libx264 is
 * already multi-threaded: one encode alone spreads across the box. Past 8 the
 * curve is flat inside run-to-run noise while per-clip latency keeps climbing
 * (30 s at 8 workers, 55 s at 16), so 8 is where throughput stops improving and
 * only the wait gets worse.
 *
 * Capping threads per encode to hand each worker its own slice was tried and is
 * WORSE at every point — 4 workers x 4 threads gave 11.88 clips/min against
 * 13.26 uncapped, 16x1 gave 15.79 against 16.26. The kernel schedules the
 * oversubscription better than a static split does, so there is no -threads
 * flag here on purpose.
 *
 * ── Why it yields to renders ────────────────────────────────────────────────
 *
 * Both workloads want the same sixteen cores, and rendering is far the more
 * expensive one: ~38 s of whole-box time for a 40 s clip against ~3.9 s to face
 * track it. Running a full facetrack pool beside renders slows the renders by
 * about half while saving only ~9% of combined wall time, which is a bad trade
 * when the render is what the user is waiting on. So the pool runs wide when
 * the box is otherwise free and narrows while a render holds it.
 */
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { SourceCache } from "./sourceCache.ts";
import type { FacetrackWorkerJob, FacetrackWorkerResult } from "./worker.ts";

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.ts");

export interface PoolOptions {
  /** Workers allowed to run while nothing is rendering. */
  maxWorkers: number;
  /** Workers allowed to run while a render holds the box. */
  maxWorkersWhileRendering: number;
  /** True when a render is in flight, so the pool should stand back. */
  isRenderBusy: () => boolean;
  /** Where shared source downloads are kept. */
  tmpDir: string;
}

interface Pending {
  job: FacetrackWorkerJob;
  resolve: (r: FacetrackWorkerResult) => void;
}

interface Worker {
  proc: ChildProcess;
  current: Pending | null;
  buf: string;
}

export class FacetrackPool {
  private readonly opts: PoolOptions;
  private readonly queue: Pending[] = [];
  private readonly workers = new Set<Worker>();
  private readonly sources: SourceCache;
  private stopping = false;
  private fetching = 0;

  constructor(opts: PoolOptions) {
    this.opts = opts;
    this.sources = new SourceCache(opts.tmpDir);
  }

  /** Sources being downloaded right now, which hold no worker slot. */
  get downloading(): number {
    return this.fetching;
  }

  /** Drops source videos nothing has used lately. */
  sweepSources(): Promise<void> {
    return this.sources.sweep();
  }

  /** Jobs waiting for a worker. */
  get queueDepth(): number {
    return this.queue.length;
  }

  /** Jobs currently being cropped. */
  get running(): number {
    let n = 0;
    for (const w of this.workers) if (w.current) n++;
    return n;
  }

  /** How many workers may be busy right now, given what else the box is doing. */
  private currentLimit(): number {
    return this.opts.isRenderBusy()
      ? this.opts.maxWorkersWhileRendering
      : this.opts.maxWorkers;
  }

  /**
   * Queues a crop, fetching its source first.
   *
   * The download happens BEFORE the job takes a worker slot, deliberately: it
   * is network wait, not CPU, so making it hold one of the eight slots would
   * idle a core for no reason. Several clips of one source collapse onto a
   * single download inside the cache.
   *
   * A source that cannot be fetched fails only that clip. The app already
   * treats a failed crop as "retry it", and one unreachable URL should not take
   * down the batch around it.
   */
  async submit(job: FacetrackWorkerJob): Promise<FacetrackWorkerResult> {
    let localPath: string | undefined;
    this.fetching++;
    try {
      localPath = await this.sources.get(job.videoUrl);
    } catch (err) {
      return {
        id: job.id,
        ok: false,
        error: `Could not fetch source video: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      this.fetching--;
    }

    return new Promise((resolve) => {
      this.queue.push({ job: { ...job, localPath }, resolve });
      this.pump();
    });
  }

  private pump(): void {
    if (this.stopping) return;

    while (this.queue.length > 0 && this.running < this.currentLimit()) {
      // Prefer a worker that is already warm; only spawn when every existing
      // one is busy and the limit still allows another.
      let worker = [...this.workers].find((w) => !w.current);
      if (!worker) {
        if (this.workers.size >= this.currentLimit()) return;
        worker = this.spawnWorker();
      }
      const pending = this.queue.shift();
      if (!pending) return;
      worker.current = pending;
      worker.proc.stdin?.write(JSON.stringify(pending.job) + "\n");
    }
  }

  private spawnWorker(): Worker {
    const proc = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", WORKER_PATH],
      { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env } },
    );

    const worker: Worker = { proc, current: null, buf: "" };
    this.workers.add(worker);

    proc.stdout?.on("data", (chunk: Buffer) => {
      worker.buf += chunk.toString();
      let nl: number;
      while ((nl = worker.buf.indexOf("\n")) >= 0) {
        const line = worker.buf.slice(0, nl);
        worker.buf = worker.buf.slice(nl + 1);
        if (!line.startsWith("RESULT ")) continue;
        const pending = worker.current;
        worker.current = null;
        if (!pending) continue;
        try {
          pending.resolve(JSON.parse(line.slice(7)) as FacetrackWorkerResult);
        } catch (err) {
          pending.resolve({
            id: pending.job.id,
            ok: false,
            error: `Unparseable worker result: ${(err as Error).message}`,
          });
        }
        this.pump();
      }
    });

    // A worker that dies mid-job is the case this whole design exists to
    // contain: fail that one clip, drop the corpse, and carry on. The caller
    // treats it like any other failed crop and retries it.
    const die = (why: string) => {
      this.workers.delete(worker);
      const pending = worker.current;
      worker.current = null;
      if (pending) pending.resolve({ id: pending.job.id, ok: false, error: why });
      this.pump();
    };

    proc.on("exit", (code, signal) =>
      die(`Face-tracking worker exited (code=${code ?? "null"}, signal=${signal ?? "none"})`),
    );
    proc.on("error", (err) => die(`Face-tracking worker failed to start: ${err.message}`));

    return worker;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const w of this.workers) {
      try { w.proc.stdin?.end(); } catch {}
      try { w.proc.kill("SIGTERM"); } catch {}
    }
    this.workers.clear();
  }
}
