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
import { spawn } from "node:child_process";
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
import { FacetrackPool } from "./facetrack/pool.ts";

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
/**
 * Renders running at once. 1 = every render gets the whole machine
 * (RENDER_MEDIA_CONCURRENCY tabs plus ffmpeg's encoder threads), and everything
 * else waits its turn in the FIFO queue.
 *
 * A previous revision ran a second job concurrently on a single reserved tab so
 * it need not wait behind a long render. That was removed: a 1-tab render is
 * ~8-10x slower, and splitting the box made BOTH jobs worse than running them
 * back to back. Sequential-at-full-speed is the better trade.
 */
const MAX_PARALLEL_JOBS = intEnv("MAX_PARALLEL_JOBS", 1);
const MAX_QUEUE_DEPTH = intEnv("MAX_QUEUE_DEPTH", 50);
const JOB_TIMEOUT_MS = intEnv("RENDER_JOB_TIMEOUT_MS", 15 * 60 * 1000);
const JOB_RETENTION_MS = intEnv("JOB_RETENTION_MS", 24 * 60 * 60 * 1000);
const DELAY_RENDER_TIMEOUT_MS = intEnv("DELAY_RENDER_TIMEOUT_MS", 300_000);

/**
 * Face-tracking pool size. See src/facetrack/pool.ts for the measured curve —
 * 8 is where throughput stops improving on this box and only latency grows.
 *
 * The second number is the cap while a render is in flight, and it is the one
 * that needed measuring. Both workloads want the same sixteen cores, and this
 * box is already saturated by either alone: overlapping them is worth about
 * nothing in total (141.9 s together against 143.0 s back to back), so the cap
 * is not buying throughput — it is choosing who waits.
 *
 * Measured 2026-09-19, two renders and sixteen crops submitted together, with
 * a solo render at 38.4 s/job for reference:
 *
 *     cap 1   render 46.1 s/job (1.20x)   6.50 clips/min   combined 147.8 s
 *     cap 2   render 55.3 s/job (1.44x)   6.99 clips/min   combined 137.4 s  <-
 *     cap 3   render 66.1 s/job (1.72x)   6.77 clips/min   combined 141.9 s
 *
 * Two is the minimum for combined wall time, which is what a project's total
 * processing time is made of, and it keeps the render penalty short of 1.5x.
 * Drop it to 1 if render latency is ever what users complain about: that costs
 * 7% of total pipeline time and hands the renders most of it back.
 */
const MAX_PARALLEL_FACETRACK = intEnv("MAX_PARALLEL_FACETRACK", 8);
const MAX_PARALLEL_FACETRACK_BUSY = intEnv("MAX_PARALLEL_FACETRACK_BUSY", 2);
/**
 * How many crops may be waiting here before the server starts refusing them.
 *
 * Sized against what the app actually sends: processVideo runs at most five
 * projects at once and each holds at most twelve clips in this queue
 * (MAX_CROPS_IN_FLIGHT_PER_PROJECT), so 60 in normal operation. 128 leaves room
 * for re-trims and rescue crops to get in alongside a busy import.
 *
 * The real backlog does NOT live here. A hundred submitted videos wait in
 * Inngest, which is durable and survives this container being rebuilt; this
 * queue is just the buffer that keeps the workers fed. A 429 is backpressure,
 * not failure — the app keeps the clip queued and feeds it in when a slot frees.
 */
const MAX_FACETRACK_QUEUE_DEPTH = intEnv("MAX_FACETRACK_QUEUE_DEPTH", 128);
const FACETRACK_RETENTION_MS = intEnv("FACETRACK_RETENTION_MS", 6 * 60 * 60 * 1000);
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

/**
 * Which GL backend Chromium rasterises with.
 *
 * Still software in every case — this box has no GPU the container can reach
 * (no `devices:` mapping, and `/dev/dri` does not exist inside it), so ANGLE
 * runs over SwiftShader either way. `gl` only picks which code path gets there.
 *
 * Measured 2026-09-19 on the CX53, shortshero `render`, a real face-tracked
 * 1080x1920 source with 96 real caption words, two jobs per run:
 *
 *     swangle   122.6 s   (61.3 s/job)   <- what this used to be
 *     angle      76.7 s   (38.4 s/job)   1.60x faster, reproduced twice
 *
 * Output is equivalent, not merely close: SSIM 0.9905 / PSNR 45.8 dB average
 * (min 43.9) between the two renders of the same job, and an amplified
 * difference map shows only anti-aliasing fringes on edges and glyph borders —
 * captions land on the same pixels, nothing is missing. Part of even that is
 * the two separate h264 encodes, not rasterisation.
 *
 * Kept overridable because this is exactly the kind of flag that behaves
 * differently on a box with a real GPU, and because `swangle` is the documented
 * escape hatch if a future composition's WebGL content misbehaves under plain
 * `angle`.
 */
const GL_BACKENDS = ["angle", "angle-egl", "egl", "swangle", "swiftshader", "vulkan"] as const;
type GlBackend = (typeof GL_BACKENDS)[number];
const glBackend: GlBackend = GL_BACKENDS.includes(process.env.RENDER_GL as GlBackend)
  ? (process.env.RENDER_GL as GlBackend)
  : "angle";

const chromiumOptions: ChromiumOptions = {
  enableMultiProcessOnLinux: true,
  gl: glBackend,
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

// ── Face-tracking job store ───────────────────────────────────────────────────
//
// Deliberately NOT in the render journal. A render is minutes of work worth
// resuming across a restart; a crop is seconds, and the app already treats a
// missing or failed crop as "retry it". Persisting these would buy nothing and
// give the journal a second schema to stay compatible with.

type FacetrackStatus = "queued" | "cropping" | "completed" | "failed";

interface FacetrackJob {
  facetrackJobId: string;
  idempotencyKey: string;
  outputKey: string;
  status: FacetrackStatus;
  error?: string;
  url?: string;
  faceFocusY?: number;
  tracked?: boolean;
  speakerLayout?: string;
  speakerSlots?: number | null;
  stackedRanges?: { start: number; end: number }[];
  /** Set when the multi-speaker probe could not RUN here — see /health's facetrack.pose. */
  multiUpError?: string;
  createdAt: number;
  completedAt?: number;
}

const facetrackJobs = new Map<string, FacetrackJob>();
const facetrackByIdempotencyKey = new Map<string, string>();

const facetrackPool = new FacetrackPool({
  maxWorkers: MAX_PARALLEL_FACETRACK,
  maxWorkersWhileRendering: MAX_PARALLEL_FACETRACK_BUSY,
  isRenderBusy: () => runningJobs > 0,
  tmpDir,
});

/**
 * Can a worker load the multi-speaker detector's package at all?
 *
 * Checked ONCE at boot, in a throwaway child process rather than here, for the
 * same reason the crops themselves run in workers: `@tensorflow-models/*` pulls
 * the TensorFlow native addon, and this process serves the app's HTTP requests.
 * The child answers the only question that matters — does `require` succeed —
 * which is precisely what failed from 2026-09-20: pose-detection's entry point
 * requires its `@mediapipe/pose` PEER, `npm install --legacy-peer-deps` does not
 * install peers, and every clip since silently came back single-speaker while
 * BlazeFace (a different package, already installed) kept the single-speaker
 * camera working perfectly. Nothing in /health could have told you.
 *
 * Deliberately NOT fatal: a box that cannot stack can still render, still crop
 * and still follow a speaker. It just has to say so out loud.
 */
let poseHealth: { ok: boolean; error?: string } = { ok: false, error: "not checked yet" };

const checkPoseHealth = () => {
  const probe = spawn(
    process.execPath,
    ["-e", "require('@tensorflow-models/pose-detection')"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  probe.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
  probe.on("error", (err) => { poseHealth = { ok: false, error: err.message }; });
  probe.on("exit", (code) => {
    if (code === 0) {
      poseHealth = { ok: true };
      console.log("[facetrack] Multi-speaker probe available (pose-detection loads).");
      return;
    }
    const first = stderr.split("\n").map((l) => l.trim()).find((l) => /Error|Cannot find/.test(l))
      ?? `pose-detection failed to load (exit ${code ?? "null"})`;
    poseHealth = { ok: false, error: first };
    console.error(
      `[facetrack] MULTI-UP UNAVAILABLE — @tensorflow-models/pose-detection will not load, ` +
      `so NO clip will be stacked into 2/3/4 speakers on this box: ${first}`,
    );
  });
};
checkPoseHealth();

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

/**
 * Directories under tmpDir that are NOT abandoned render workdirs.
 *
 * This sweep runs at boot and deletes every directory it finds, on the premise
 * that each one is a workdir whose render died with the process. The
 * face-tracking source cache lives here too and is not that: it is a warm cache
 * shared by every clip of a video, with its own TTL, and wiping it on boot
 * would make a deploy in the middle of an import re-download a source that can
 * be hundreds of megabytes, once per clip still waiting.
 */
const TMP_KEEP = new Set(["facetrack-sources"]);

const sweepOrphanedWorkdirs = async () => {
  try {
    const entries = await fs.readdir(tmpDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !TMP_KEEP.has(entry.name))
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
      // A render is written once to a key that is never rewritten — the app
      // derives a fresh key per export — so it can be cached forever.
      //
      // Without this R2 sends no Cache-Control at all, and a header the app's
      // own uploads have always set was missing on the one file users actually
      // download and replay: verified on a live export, `cache-control: <none>`
      // against `public, max-age=31536000, immutable` on cdn.shortshero.com.
      // The browser therefore re-fetched a finished video on every replay, and
      // no edge cache could hold it whatever the zone's rules said.
      CacheControl: "public, max-age=31536000, immutable",
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
    console.log(
      `Job ${job.renderJobId} starting (concurrency=${RENDER_CONCURRENCY}, ` +
        `queued=${queue.length})`,
    );
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
    maxParallelJobs: MAX_PARALLEL_JOBS,
    scale: RENDER_SCALE,
    crf: RENDER_CRF ?? 18,
    gl: glBackend,
    facetrack: {
      running: facetrackPool.running,
      queueDepth: facetrackPool.queueDepth,
      downloading: facetrackPool.downloading,
      maxWorkers: MAX_PARALLEL_FACETRACK,
      maxWorkersWhileRendering: MAX_PARALLEL_FACETRACK_BUSY,
      // Surfaced because writing crops to the render bucket instead of the
      // app's upload bucket fails the RENDER, not the upload — see the note in
      // src/facetrack/r2.ts. This makes the mistake visible from /health.
      bucket: process.env.FACETRACK_R2_BUCKET || r2Bucket,
      publicUrl: (process.env.FACETRACK_R2_PUBLIC_URL || r2PublicUrl).replace(/\/$/, ""),
      // Whether the MULTI-SPEAKER probe can run, which is a separate question
      // from whether face tracking works: BlazeFace (the single-speaker camera)
      // and MoveNet (the 2/3/4-up stack) are different models with different
      // dependencies, so the box can crop every clip perfectly while stacking
      // none of them. That is exactly what it did from 2026-09-20, when
      // `npm install --legacy-peer-deps` left out pose-detection's
      // `@mediapipe/pose` peer and 912 clips came out single-speaker in
      // silence. Anything but "ok" here means no clip is being stacked.
      pose: poseHealth,
    },
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

// ── Face tracking ─────────────────────────────────────────────────────────────
//
// Same contract as /jobs: submit, poll, read the result. The app used to do
// this work inside its own web process on the CX33 under a global limit of one
// (shortshero/inngest/concurrency.ts), because a second concurrent crop there
// exhausted the 3 GiB container and the run died as "Your server returned HTTP
// 502 before the SDK responded". Measured 2026-09-19, the CX33 could not be
// made faster by raising that limit either — 4 vCPU tops out at 4.27 clips/min
// against 15.51 here. So the crop moves to the box with the cores, and the app
// is left holding nothing heavier than an HTTP poll.

const facetrackSchema = z.object({
  videoUrl: z.string().min(1),
  startTime: z.number().nonnegative(),
  endTime: z.number().positive(),
  outputKey: z.string().min(1),
  idempotencyKey: z.string().min(1),
});

const toFacetrackPayload = (job: FacetrackJob) => ({
  facetrackJobId: job.facetrackJobId,
  status: job.status,
  ...(job.error ? { error: job.error } : {}),
  ...(job.status === "completed"
    ? {
        url: job.url,
        outputKey: job.outputKey,
        faceFocusY: job.faceFocusY,
        tracked: job.tracked,
        speakerLayout: job.speakerLayout,
        speakerSlots: job.speakerSlots ?? null,
        stackedRanges: job.stackedRanges ?? [],
        ...(job.multiUpError ? { multiUpError: job.multiUpError } : {}),
      }
    : {}),
});

app.post("/facetrack", requireAuth, (req, res) => {
  const parsed = facetrackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const request = parsed.data;

  if (request.endTime <= request.startTime) {
    res.status(400).json({ error: "endTime must be greater than startTime" });
    return;
  }

  // Same idempotency rule as renders: replaying a key returns the live job,
  // unless it failed, in which case this is a retry and gets a fresh attempt.
  const existingId = facetrackByIdempotencyKey.get(request.idempotencyKey);
  const existing = existingId ? facetrackJobs.get(existingId) : undefined;
  if (existing && existing.status !== "failed") {
    res.json(toFacetrackPayload(existing));
    return;
  }

  // Backpressure, not failure. The app resubmits on a later tick rather than
  // marking a clip broken — see isQueueFullError in shortshero/lib.
  if (facetrackPool.queueDepth >= MAX_FACETRACK_QUEUE_DEPTH) {
    res.status(429).json({
      error: `Face-tracking queue is full (${MAX_FACETRACK_QUEUE_DEPTH} jobs)`,
    });
    return;
  }

  const job: FacetrackJob = {
    facetrackJobId: crypto.randomUUID(),
    idempotencyKey: request.idempotencyKey,
    outputKey: request.outputKey,
    status: "queued",
    createdAt: Date.now(),
  };
  facetrackJobs.set(job.facetrackJobId, job);
  facetrackByIdempotencyKey.set(job.idempotencyKey, job.facetrackJobId);

  void facetrackPool
    .submit({
      id: job.facetrackJobId,
      videoUrl: request.videoUrl,
      startTime: request.startTime,
      endTime: request.endTime,
      outputKey: request.outputKey,
    })
    .then((result) => {
      job.completedAt = Date.now();
      if (result.ok) {
        job.status = "completed";
        job.url = result.url;
        job.faceFocusY = result.faceFocusY;
        job.tracked = result.tracked;
        job.speakerLayout = result.speakerLayout;
        job.speakerSlots = result.speakerSlots ?? null;
        job.stackedRanges = result.stackedRanges ?? [];
        job.multiUpError = result.multiUpError;
        console.log(
          `[facetrack] ${job.facetrackJobId} → ${result.url}` +
            (result.tracked ? "" : " (centre crop — detection unavailable)"),
        );
      } else {
        job.status = "failed";
        job.error = result.error ?? "Face tracking failed";
        console.error(`[facetrack] ${job.facetrackJobId} failed: ${job.error}`);
      }
    });

  job.status = "cropping";
  res.status(202).json(toFacetrackPayload(job));
});

app.get("/facetrack/:id", (req, res) => {
  const job = facetrackJobs.get(String(req.params.id));
  if (!job) {
    res.status(404).json({ error: "Face-tracking job not found" });
    return;
  }
  res.json(toFacetrackPayload(job));
});

/** Drops finished crops the app has had ample time to read. */
const pruneFacetrackJobs = () => {
  const cutoff = Date.now() - FACETRACK_RETENTION_MS;
  for (const [id, job] of facetrackJobs) {
    if (job.completedAt && job.completedAt < cutoff) {
      facetrackJobs.delete(id);
      if (facetrackByIdempotencyKey.get(job.idempotencyKey) === id) {
        facetrackByIdempotencyKey.delete(job.idempotencyKey);
      }
    }
  }
};

// ── Boot ──────────────────────────────────────────────────────────────────────

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}, shutting down`);
  // Force-exit if the browser is wedged (e.g. mid-download/launch) so a deploy
  // or docker stop can never hang on graceful shutdown.
  setTimeout(() => process.exit(0), 10_000);
  await persistNow();
  await closeBrowser();
  await facetrackPool.shutdown();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

const main = async () => {
  await fs.mkdir(tmpDir, { recursive: true });
  await restoreJournal();
  await sweepOrphanedWorkdirs();
  setInterval(pruneOldJobs, 60 * 60 * 1000).unref();
  setInterval(pruneFacetrackJobs, 30 * 60 * 1000).unref();
  setInterval(() => void facetrackPool.sweepSources(), 30 * 60 * 1000).unref();

  app.listen(port, () => {
    console.log(
      `VPS render server listening on ${port} ` +
        `(concurrency=${RENDER_CONCURRENCY}, ` +
        `parallelJobs=${MAX_PARALLEL_JOBS}, jobTimeout=${Math.round(JOB_TIMEOUT_MS/60000)}m, ` +
        `scale=${RENDER_SCALE}, x264Preset=${x264Preset ?? "medium (default)"}, ` +
        `crf=${RENDER_CRF ?? "18 (Remotion default)"}, gl=${glBackend}, ` +
        `facetrack=${MAX_PARALLEL_FACETRACK}/${MAX_PARALLEL_FACETRACK_BUSY} workers)`,
    );
    if (!authToken) console.warn("WARNING: RENDER_SERVER_TOKEN not set — set it in production!");
    // Warm the browser so the first job skips the Chromium cold start.
    void getBrowser().catch((error) => console.error("Browser warmup failed:", error));
  });
};

void main();
