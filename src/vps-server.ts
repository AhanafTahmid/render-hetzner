/**
 * Standalone render server for a dedicated VPS (Hetzner CX53, 16 vCPU / 32 GB).
 *
 * Replaces the Cloudflare Worker + Durable Object + Containers pipeline with a
 * single long-running process. Same HTTP contract as the Worker, so the app
 * only swaps the base URL:
 *
 *   POST /jobs              → { renderJobId, status }        (Bearer auth)
 *   GET  /jobs/:id          → { status, progress, outputKey?, error?, metrics? }
 *   GET  /jobs/:id/output   → 302 to the R2 public URL
 *   POST /jobs/:id/cancel   → cancels an in-flight render    (Bearer auth)
 *   GET  /health            → liveness + queue depth
 *
 * Unlike the container fleet there is no chunking: one renderMedia() call per
 * job uses the whole machine via `concurrency` (default 16 = all cores), with a
 * FIFO queue in front and the finished MP4 uploaded straight to R2.
 */

import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { z } from "zod";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  ensureBrowser,
  makeCancelSignal,
  openBrowser,
  renderMedia,
  selectComposition,
  type ChromiumOptions,
} from "@remotion/renderer";
import type { VideoConfig } from "remotion/no-react";
import {
  AUDIO_CODEC,
  BUNDLE_DIR,
  CONTAINER_PORT,
  DEFAULT_COMPOSITION_ID,
  VIDEO_CODEC,
} from "./constants.ts";
import type { JsonObject } from "./types.ts";

// ── Configuration ─────────────────────────────────────────────────────────────

const intEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const port = intEnv("PORT", CONTAINER_PORT);
const bundlePath = path.join(process.cwd(), BUNDLE_DIR);
const tmpDir = process.env.RENDER_TMP_DIR ?? "/render-tmp";
const jobStateFile = path.join(tmpDir, "jobs.json");
const authToken = process.env.RENDER_SERVER_TOKEN ?? "";

/**
 * Browser tabs rendering frames in parallel. Deliberately BELOW the core count:
 * benchmarked on a real 1698-frame vidshero job on the 16-core CX53, 8 rendered
 * in 78.7-83.8s vs 84.7s at 16 — past ~12 the capture tabs thrash against
 * ffmpeg's encoder threads instead of adding throughput. Remotion caps this at
 * the core count anyway. Re-benchmark if the composition or box changes.
 */
const RENDER_CONCURRENCY = intEnv("RENDER_MEDIA_CONCURRENCY", 8);
/**
 * Output scale (Remotion `scale`, i.e. the browser's deviceScaleFactor). The
 * composition stays 1080x1920 — only the rasterised output shrinks — so layout
 * is pixel-identical and absolute px sizes (captions are `fontSize: 72`) keep
 * their proportions. Changing COMP_DIMS instead would resize the canvas and
 * make captions ~50% larger relative to the frame.
 *
 * 2/3 => 720x1280, which is 2.25x fewer pixels to rasterise. Source clips are
 * 720x1280 and 360x640, so 1080p output is upscaling regardless.
 */
const RENDER_SCALE = Number.parseFloat(process.env.RENDER_SCALE ?? "") || 1;
/** Renders running at once. 1 gives each render the full machine. */
const MAX_PARALLEL_JOBS = intEnv("MAX_PARALLEL_JOBS", 1);
const MAX_QUEUE_DEPTH = intEnv("MAX_QUEUE_DEPTH", 50);
const JOB_TIMEOUT_MS = intEnv("RENDER_JOB_TIMEOUT_MS", 15 * 60 * 1000);
const JOB_RETENTION_MS = intEnv("JOB_RETENTION_MS", 24 * 60 * 60 * 1000);
const DELAY_RENDER_TIMEOUT_MS = intEnv("DELAY_RENDER_TIMEOUT_MS", 300_000);
/**
 * OffthreadVideo frame cache. 4 GB keeps source clips decoded in RAM. Sized for
 * the 32 GB box: 16 Chromium tabs need headroom, so this stays well under half.
 */
const OFFTHREAD_CACHE_BYTES = intEnv("OFFTHREAD_VIDEO_CACHE_BYTES", 4 * 1024 * 1024 * 1024);

const X264_PRESETS = [
  "ultrafast", "superfast", "veryfast", "faster", "fast",
  "medium", "slow", "slower", "veryslow", "placebo",
] as const;
type X264Preset = (typeof X264_PRESETS)[number];
const x264Preset: X264Preset | undefined = X264_PRESETS.includes(
  process.env.RENDER_X264_PRESET as X264Preset,
)
  ? (process.env.RENDER_X264_PRESET as X264Preset)
  : undefined;

/**
 * h264 quality. Remotion defaults to CRF 18 (archival-grade) when this is
 * undefined, which produced ~9.3 Mbps / 65 MB for a 57s 1080p export -- a lot of
 * bits spent on footage whose sources are only 720x1280 and 360x640. Lower
 * number = higher quality + bigger file; each +6 roughly halves the bitrate.
 *
 * Unlike RENDER_SCALE this does NOT reduce raster work, so expect render time to
 * be flat; the win is a smaller file, which shortens the R2 upload that sits
 * inside the job's wall-clock. Remotion's valid range for h264 is 1-51; anything
 * outside it is ignored so a typo can't silently wreck output quality.
 */
const RENDER_CRF: number | undefined = (() => {
  const parsed = Number.parseInt(process.env.RENDER_CRF ?? "", 10);
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed < 1 || parsed > 51) {
    console.warn(`[config] Ignoring RENDER_CRF=${process.env.RENDER_CRF} (valid range is 1-51)`);
    return undefined;
  }
  return parsed;
})();

const r2Bucket = process.env.R2_BUCKET ?? "";
const r2PublicUrl = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
  },
});

const chromiumOptions: ChromiumOptions = {
  enableMultiProcessOnLinux: true,
  // Software GL (SwiftShader + ANGLE): the VPS has no GPU, and leaving gl unset
  // can crash the GL context on WebGL/canvas content.
  gl: "swangle",
};

// ── Warm browser (shared across all jobs) ─────────────────────────────────────

let browserPromise: Promise<Awaited<ReturnType<typeof openBrowser>>> | null = null;

const getBrowser = async () => {
  if (!browserPromise) {
    browserPromise = (async () => {
      await ensureBrowser();
      return openBrowser("chrome", { chromiumOptions, logLevel: "info" });
    })().catch((error) => {
      browserPromise = null;
      throw error;
    });
  }
  return browserPromise;
};

const closeBrowser = async () => {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  await browser?.close({ silent: true }).catch(() => undefined);
};

// ── Job store ─────────────────────────────────────────────────────────────────

type VpsJobStatus = "queued" | "planning" | "rendering" | "combining" | "completed" | "failed";

interface VpsJobMetrics {
  provider: "hetzner-vps";
  queueWaitMs?: number;
  planDurationMs?: number;
  totalElapsedMs?: number;
  finalUploadMs?: number;
  /** Single-sample shape kept compatible with the old chunk metrics consumers. */
  chunkRenderMs?: { count: number; totalMs: number; avgMs: number; maxMs: number; lastMs: number };
}

interface VpsJob {
  renderJobId: string;
  compositionId: string;
  inputProps: JsonObject;
  outputKey: string;
  idempotencyKey: string;
  status: VpsJobStatus;
  progress: number;
  totalFrames?: number;
  error?: string;
  metrics: VpsJobMetrics;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

const jobs = new Map<string, VpsJob>();
const jobsByIdempotencyKey = new Map<string, string>();
const queue: string[] = [];
const cancelers = new Map<string, () => void>();
let runningJobs = 0;

// ── Journal (crash recovery) ──────────────────────────────────────────────────

let persistTimer: NodeJS.Timeout | null = null;

const persistNow = async () => {
  const snapshot = JSON.stringify({ jobs: [...jobs.values()] });
  const tmpFile = `${jobStateFile}.tmp`;
  try {
    await fs.writeFile(tmpFile, snapshot);
    await fs.rename(tmpFile, jobStateFile);
  } catch (error) {
    console.warn("Failed to persist job journal:", error);
  }
};

const persistSoon = () => {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, 500);
};

const restoreJournal = async () => {
  try {
    const raw = await fs.readFile(jobStateFile, "utf8");
    const parsed = JSON.parse(raw) as { jobs?: VpsJob[] };
    for (const job of parsed.jobs ?? []) {
      // Anything non-terminal died with the previous process. Mark it failed —
      // the Inngest poll loop handles "failed" and the caller re-triggers.
      if (job.status !== "completed" && job.status !== "failed") {
        job.status = "failed";
        job.error = "Render server restarted while the job was in flight";
        job.completedAt = Date.now();
      }
      jobs.set(job.renderJobId, job);
      jobsByIdempotencyKey.set(job.idempotencyKey, job.renderJobId);
    }
    if (jobs.size > 0) console.log(`Restored ${jobs.size} job records from journal`);
  } catch {
    // No journal yet — first boot.
  }
};

const pruneOldJobs = () => {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [id, job] of jobs) {
    const finished = job.status === "completed" || job.status === "failed";
    if (finished && (job.completedAt ?? job.createdAt) < cutoff) {
      jobs.delete(id);
      if (jobsByIdempotencyKey.get(job.idempotencyKey) === id) {
        jobsByIdempotencyKey.delete(job.idempotencyKey);
      }
    }
  }
  persistSoon();
};

const sweepOrphanedWorkdirs = async () => {
  try {
    const entries = await fs.readdir(tmpDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => fs.rm(path.join(tmpDir, entry.name), { recursive: true, force: true })),
    );
  } catch {
    // tmpDir may not exist yet.
  }
};

// ── Status payload (same shape lib/cloudflare-render.ts parses) ───────────────

const setJob = (job: VpsJob, patch: Partial<VpsJob>) => {
  Object.assign(job, patch);
  persistSoon();
};

const toStatusPayload = (job: VpsJob) => ({
  renderJobId: job.renderJobId,
  status: job.status,
  progress: job.progress,
  outputKey: job.status === "completed" ? job.outputKey : undefined,
  error: job.error,
  totalFrames: job.totalFrames,
  workerPoolSize: 1,
  metrics: job.metrics,
});

// ── R2 upload ─────────────────────────────────────────────────────────────────

const uploadFileToR2 = async (filePath: string, key: string) => {
  const upload = new Upload({
    client: r2,
    params: {
      Bucket: r2Bucket,
      Key: key,
      Body: createReadStream(filePath),
      ContentType: "video/mp4",
    },
    partSize: 8 * 1024 * 1024,
    queueSize: 4,
  });
  await upload.done();
};

// ── Render pipeline ───────────────────────────────────────────────────────────

const runJob = async (job: VpsJob) => {
  const jobDir = path.join(tmpDir, job.renderJobId);
  const outputLocation = path.join(jobDir, "output.mp4");
  const startedAt = Date.now();
  const { cancelSignal, cancel } = makeCancelSignal();
  cancelers.set(job.renderJobId, cancel);

  const watchdog = setTimeout(() => {
    console.error(`Job ${job.renderJobId} exceeded ${JOB_TIMEOUT_MS}ms — cancelling`);
    cancel();
  }, JOB_TIMEOUT_MS);

  try {
    setJob(job, {
      status: "planning",
      progress: 2,
      startedAt,
      metrics: { ...job.metrics, queueWaitMs: startedAt - job.createdAt },
    });
    await fs.mkdir(jobDir, { recursive: true });

    const browser = await getBrowser();
    const planStarted = Date.now();
    const composition = (await selectComposition({
      serveUrl: bundlePath,
      id: job.compositionId,
      inputProps: job.inputProps,
      timeoutInMilliseconds: 60_000,
      logLevel: "info",
      puppeteerInstance: browser,
      chromiumOptions,
    })) as VideoConfig;
    const planDurationMs = Date.now() - planStarted;

    setJob(job, {
      status: "rendering",
      progress: 3,
      totalFrames: composition.durationInFrames,
      metrics: { ...job.metrics, planDurationMs },
    });

    const renderStarted = Date.now();
    await renderMedia({
      composition,
      serveUrl: bundlePath,
      codec: VIDEO_CODEC,
      audioCodec: AUDIO_CODEC,
      outputLocation,
      inputProps: job.inputProps,
      concurrency: RENDER_CONCURRENCY,
      scale: RENDER_SCALE,
      x264Preset,
      crf: RENDER_CRF,
      offthreadVideoCacheSizeInBytes: OFFTHREAD_CACHE_BYTES,
      timeoutInMilliseconds: DELAY_RENDER_TIMEOUT_MS,
      logLevel: "info",
      puppeteerInstance: browser,
      chromiumOptions,
      cancelSignal,
      onProgress: ({ progress }) => {
        // Map render progress into 3–96; upload takes 97–99, completed = 100.
        const next = Math.min(96, Math.max(3, 3 + Math.round(progress * 93)));
        if (next > job.progress) setJob(job, { progress: next });
      },
    });
    const renderMs = Date.now() - renderStarted;

    setJob(job, {
      status: "combining",
      progress: 97,
      metrics: {
        ...job.metrics,
        chunkRenderMs: { count: 1, totalMs: renderMs, avgMs: renderMs, maxMs: renderMs, lastMs: renderMs },
      },
    });

    const uploadStarted = Date.now();
    await uploadFileToR2(outputLocation, job.outputKey);
    const finalUploadMs = Date.now() - uploadStarted;
    const completedAt = Date.now();

    setJob(job, {
      status: "completed",
      progress: 100,
      completedAt,
      metrics: { ...job.metrics, finalUploadMs, totalElapsedMs: completedAt - job.createdAt },
    });
    console.log(
      `Job ${job.renderJobId} completed: ${composition.durationInFrames} frames, ` +
        `render ${renderMs}ms, upload ${finalUploadMs}ms → r2://${r2Bucket}/${job.outputKey}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Job ${job.renderJobId} failed:`, error);
    setJob(job, {
      status: "failed",
      error: message,
      completedAt: Date.now(),
      metrics: { ...job.metrics, totalElapsedMs: Date.now() - job.createdAt },
    });
  } finally {
    clearTimeout(watchdog);
    cancelers.delete(job.renderJobId);
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

const pump = () => {
  while (runningJobs < MAX_PARALLEL_JOBS && queue.length > 0) {
    const jobId = queue.shift();
    const job = jobId ? jobs.get(jobId) : undefined;
    if (!job || job.status !== "queued") continue;
    runningJobs += 1;
    void runJob(job).finally(() => {
      runningJobs -= 1;
      pump();
    });
  }
};

// ── HTTP API ──────────────────────────────────────────────────────────────────

const createJobSchema = z.object({
  compositionId: z.string().min(1).default(DEFAULT_COMPOSITION_ID),
  inputProps: z.custom<JsonObject>(),
  outputKey: z.string().min(1),
  idempotencyKey: z.string().min(1),
  // Accepted for compatibility with the Cloudflare payload; ignored here.
  targetChunkCount: z.number().int().positive().optional(),
  maxWorkerPoolSize: z.number().int().positive().optional(),
});

const timingSafeMatch = (provided: string): boolean => {
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(authToken).digest();
  return crypto.timingSafeEqual(a, b);
};

const requireAuth: express.RequestHandler = (req, res, next) => {
  if (!authToken) {
    console.warn("RENDER_SERVER_TOKEN is not set — /jobs endpoints are UNPROTECTED");
    return next();
  }
  const provided = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!provided || !timingSafeMatch(provided)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    bundlePath,
    queueDepth: queue.length,
    runningJobs,
    concurrency: RENDER_CONCURRENCY,
    scale: RENDER_SCALE,
    crf: RENDER_CRF ?? 18,
  });
});

app.post("/jobs", requireAuth, (req, res) => {
  const parsed = createJobSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const request = parsed.data;

  // Idempotency: re-posting the same key returns the existing job unless that
  // job failed, in which case a fresh attempt is created (Inngest retry path).
  const existingId = jobsByIdempotencyKey.get(request.idempotencyKey);
  const existing = existingId ? jobs.get(existingId) : undefined;
  if (existing && existing.status !== "failed") {
    res.json({ renderJobId: existing.renderJobId, status: existing.status });
    return;
  }

  if (queue.length >= MAX_QUEUE_DEPTH) {
    res.status(429).json({ error: `Render queue is full (${MAX_QUEUE_DEPTH} jobs)` });
    return;
  }

  const job: VpsJob = {
    renderJobId: crypto.randomUUID(),
    compositionId: request.compositionId,
    inputProps: request.inputProps,
    outputKey: request.outputKey,
    idempotencyKey: request.idempotencyKey,
    status: "queued",
    progress: 0,
    metrics: { provider: "hetzner-vps" },
    createdAt: Date.now(),
  };
  jobs.set(job.renderJobId, job);
  jobsByIdempotencyKey.set(job.idempotencyKey, job.renderJobId);
  queue.push(job.renderJobId);
  persistSoon();
  pump();

  res.status(202).json({ renderJobId: job.renderJobId, status: job.status });
});

app.get("/jobs/:id", (req, res) => {
  const job = jobs.get(String(req.params.id));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(toStatusPayload(job));
});

app.get("/jobs/:id/output", (req, res) => {
  const job = jobs.get(String(req.params.id));
  if (!job || job.status !== "completed") {
    res.status(404).json({ error: "Output not available" });
    return;
  }
  if (!r2PublicUrl) {
    res.status(500).json({ error: "R2_PUBLIC_URL is not configured" });
    return;
  }
  res.redirect(302, `${r2PublicUrl}/${job.outputKey}`);
});

app.post("/jobs/:id/cancel", requireAuth, (req, res) => {
  const job = jobs.get(String(req.params.id));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (job.status === "queued") {
    const index = queue.indexOf(job.renderJobId);
    if (index !== -1) queue.splice(index, 1);
    setJob(job, { status: "failed", error: "Cancelled", completedAt: Date.now() });
  } else {
    cancelers.get(job.renderJobId)?.();
  }
  res.json({ renderJobId: job.renderJobId, status: job.status });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}, shutting down`);
  // Force-exit if the browser is wedged (e.g. mid-download/launch) so a deploy
  // or docker stop can never hang on graceful shutdown.
  setTimeout(() => process.exit(0), 10_000);
  await persistNow();
  await closeBrowser();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

const main = async () => {
  await fs.mkdir(tmpDir, { recursive: true });
  await restoreJournal();
  await sweepOrphanedWorkdirs();
  setInterval(pruneOldJobs, 60 * 60 * 1000).unref();

  app.listen(port, () => {
    console.log(
      `VPS render server listening on ${port} ` +
        `(concurrency=${RENDER_CONCURRENCY}, parallelJobs=${MAX_PARALLEL_JOBS}, ` +
        `scale=${RENDER_SCALE}, x264Preset=${x264Preset ?? "medium (default)"}, ` +
        `crf=${RENDER_CRF ?? "18 (Remotion default)"})`,
    );
    if (!authToken) console.warn("WARNING: RENDER_SERVER_TOKEN not set — set it in production!");
    // Warm the browser so the first job skips the Chromium cold start.
    void getBrowser().catch((error) => console.error("Browser warmup failed:", error));
  });
};

void main();
