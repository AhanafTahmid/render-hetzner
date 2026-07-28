// ── Composition ───────────────────────────────────────────────────────────────

/** Remotion composition ID to render when none is specified in the request. */
export const DEFAULT_COMPOSITION_ID = "vidshero";

// ── Chunking & parallelism ────────────────────────────────────────────────────
//
// The renderer fans a single video out across many isolated container
// instances — one chunk per worker — exactly like Remotion Lambda fans a render
// out across many concurrent lambdas. Throughput is therefore set by how many
// chunks we split into and how many workers boot in parallel. `standard-4`
// containers are 4 vCPU / 12 GiB each, and an account can run ~375 of them
// concurrently (1,500 vCPU ceiling), so the limits below are sized for speed,
// not for fitting inside the old 8-worker cap. All values are overridable from
// wrangler `vars` so they can be tuned per account without a rebuild.

/** How many chunks to split a render into when the caller doesn't ask. */
export const DEFAULT_RENDER_TARGET_CHUNK_COUNT = 8;

/**
 * Hard ceiling on chunk count, even if the caller requests more.
 *
 * Deliberately set to ~2× RENDER_WORKER_POOL_SIZE_MAX so chunks are SMALLER than
 * the number of workers, which turns the coordinator's queue into a work-stealing
 * load balancer: fast/early-booting workers pick up extra chunks instead of going
 * idle, and a single heavy scene is split across multiple workers. This collapses
 * the tail latency (the slowest container + heaviest chunk) without adding any
 * containers — so it's faster AND cheaper (less wall-clock on the same 80 workers).
 */
export const DEFAULT_RENDER_TARGET_CHUNK_COUNT_MAX = 160;

/** A chunk will never be smaller than this many frames (avoids over-splitting short videos). */
export const DEFAULT_MIN_FRAMES_PER_CHUNK = 30;

/**
 * Max worker containers that run in parallel to render chunks. This — not the
 * chunk count — is what sets your bill (80 × standard-4 = 320 vCPU, well under
 * the 1,500 vCPU account ceiling; 80 + 1 leader stays under `max_instances`).
 * Chunks (RENDER_TARGET_CHUNK_COUNT_MAX) are intentionally ~2× this so work
 * steals across the pool; raising THIS value is what increases cost.
 */
export const DEFAULT_RENDER_WORKER_POOL_SIZE_MAX = 80;

/**
 * How many frames Remotion renders in parallel inside a single container.
 * Matched to the 4 vCPU of a `standard-4` instance. Override with the
 * RENDER_MEDIA_CONCURRENCY env var when using a different instance type.
 */
export const DEFAULT_RENDER_MEDIA_CONCURRENCY = 4;

// ── Video / audio format ──────────────────────────────────────────────────────

/** Final output codec written to the MP4. */
export const VIDEO_CODEC = "h264" as const;

/** Per-chunk codec (MPEG-2 TS container, easy to concatenate). */
export const CHUNK_VIDEO_CODEC = "h264-ts" as const;

/** Audio codec used for both chunks and the final output. */
export const AUDIO_CODEC = "aac" as const;

// ── Upload tuning ─────────────────────────────────────────────────────────────

/** Files smaller than this are uploaded in one PUT; larger use multipart. */
export const MULTIPART_THRESHOLD_BYTES = 5 * 1024 * 1024;

/** Size of each part in a multipart upload. */
export const MULTIPART_PART_SIZE = 8 * 1024 * 1024;

/** How many multipart parts to upload in parallel (speeds up large final uploads). */
export const UPLOAD_PART_CONCURRENCY = 6;

/** How many chunk artifacts the combine step downloads in parallel from R2. */
export const COMBINE_DOWNLOAD_CONCURRENCY = 16;

// ── Retry limits ─────────────────────────────────────────────────────────────

/** How many times to retry a failed chunk before failing the whole job. */
export const CHUNK_RETRY_LIMIT = 2;

/** How many times to retry the combine step before failing the whole job. */
export const COMBINE_RETRY_LIMIT = 1;

// ── Timeouts ─────────────────────────────────────────────────────────────────

/** How long a chunk can stay in "rendering" before it is considered stuck. */
export const DEFAULT_STUCK_CHUNK_TIMEOUT_MS = 300_000;

/** How long the planning phase can run before the job is failed. */
export const DEFAULT_PLANNING_TIMEOUT_MS = 180_000;

/** How often the coordinator alarm fires to check for stuck work. */
export const STUCK_CHECK_INTERVAL_MS = 60_000;

// ── Container ─────────────────────────────────────────────────────────────────

/** Port the render server listens on inside the container. */
export const CONTAINER_PORT = 8080;

/** Idle time before Cloudflare destroys the container instance. */
export const CONTAINER_SLEEP_AFTER = "10m";

/** Directory (relative to cwd) where `remotion bundle` writes its output. */
export const BUNDLE_DIR = "build";

// ── Progress reporting (internal) ─────────────────────────────────────────────

/** Minimum ms between progress dispatches for the same chunk. */
export const PROGRESS_REPORT_MIN_INTERVAL_MS = 1200;

/** Minimum progress delta before a dispatch is sent (debounces tiny increments). */
export const PROGRESS_REPORT_MIN_DELTA = 4;

/** How often to log a warning when the coordinator is unreachable. */
export const PROGRESS_ERROR_LOG_INTERVAL_MS = 15_000;
