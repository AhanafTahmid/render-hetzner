# every-render.md — Wire any video SaaS app to the Hetzner render server

> **For the implementing agent:** this file is the complete, self-sufficient
> guide for connecting a video SaaS app (shortshero, vidshero, vidgpt,
> blog-template, or a new one) to the self-hosted Remotion render server.
> Follow it top to bottom; every code block is copy-paste ready. You should not
> need to read the server source to integrate an app — but it lives at
> `/Volumes/Files/programming/render-hetzner/` (server + Docker + deploy docs)
> if you do. shortshero is the reference integration (already done — see
> "Reference implementation" at the bottom).

---

## 1. What the server is

One Hetzner CX VPS (8 vCPU / 16 GB, flat ~€16.49/mo) running a single
long-lived Node process (`render-hetzner/src/vps-server.ts`) behind Caddy TLS.
It renders **whole videos in one `renderMedia()` call at concurrency 8** (all
cores), one job at a time from a FIFO queue, and uploads the finished MP4
directly to R2. No Cloudflare Workers, no Lambda, no chunking.

- Base URL: `https://<RENDER_DOMAIN>` (e.g. `https://render.yourdomain.com`)
- Auth: `Authorization: Bearer <RENDER_SERVER_TOKEN>` on all `/jobs*` routes
- Output: MP4 lands in the R2 bucket configured on the server, at the
  `outputKey` the app chooses; publicly readable at
  `<R2 public base URL>/<outputKey>`
- Typical timings on the 8-core box: a 30–90 s 1080×1920 short ≈ a couple of
  minutes; jobs queue when the box is busy (one render at a time)

### Compositions (one server, all products)

Pick per job with `compositionId` — always pass it explicitly (the server
default is `vidshero`, which is wrong for every other product):

| compositionId | Product |
|---|---|
| `vidshero` | vidshero full videos |
| `render` | shortshero shorts + exports |
| `vidgpt` | vidgpt videos |
| `blog-template` | blog-to-video templates |

Each composition's `inputProps` schema is whatever the composition component
in `render-hetzner/src/compositions/` accepts — match what the app already
passes to its `<Player>` preview, since Player and server render share the
same component.

---

## 2. HTTP API contract

```
POST /jobs                      (auth required)
  body: {
    "compositionId": "render",          // REQUIRED in practice — see table above
    "inputProps": { ... },              // props for the composition
    "outputKey": "renders/abc/output.mp4",  // where the MP4 goes in R2
    "idempotencyKey": "short:abc"       // stable per logical render — see §5
  }
  → 202 { "renderJobId": "<uuid>", "status": "queued" }
  → 401 bad/missing token · 429 queue full (retry later) · 400 bad payload

GET /jobs/:renderJobId          (poll every ~10 s)
  → {
      "status": "queued" | "planning" | "rendering" | "combining" | "completed" | "failed",
      "progress": 0-100,                // ready for a progress bar, monotonic
      "outputKey": "...",               // present only when completed
      "error": "...",                   // present when failed
      "totalFrames": 1234,              // present once planning is done
      "workerPoolSize": 1,
      "metrics": { "provider": "hetzner-vps", "totalElapsedMs": ..., ... }
    }

GET  /jobs/:renderJobId/output  → 302 redirect to the R2 public URL
POST /jobs/:renderJobId/cancel  (auth required) → cancels an in-flight render
GET  /health                    (no auth) → { status, queueDepth, runningJobs, ... }
```

Status meanings for UI copy: `queued` = waiting in render queue · `planning` =
preparing composition · `rendering` = rendering frames (progress 3–96) ·
`combining` = uploading/finalizing (97–99) · `completed` = 100 · `failed` =
show `error`, refund credits if applicable.

---

## 3. App environment variables

Add to the app's hosting env (and `.env.local` for dev):

```env
RENDER_SERVER_URL=https://render.yourdomain.com
RENDER_SERVER_TOKEN=<the token from the VPS .env — ask the owner, never invent one>
# The R2 public base URL where rendered MP4s are served from (same bucket the
# server uploads to). shortshero calls this CLOUDFLARE_R2_EXPORT_PUBLIC_URL.
CLOUDFLARE_R2_EXPORT_PUBLIC_URL=https://<public-r2-domain>
```

---

## 4. The client helper (copy into the app)

Create `lib/render-server.ts` in the app (this is the exact file shortshero
uses; trim the `COMP_DIMS` map if irrelevant):

```typescript
/**
 * Client for the Hetzner VPS render server (render-hetzner/src/vps-server.ts).
 *   POST /jobs     → { renderJobId }
 *   GET  /jobs/:id → { status, progress, outputKey?, error?, metrics? }
 */

export type RenderStatus =
  | "queued" | "planning" | "rendering" | "combining" | "completed" | "failed";

export interface RenderMetrics {
  provider?: string;              // "hetzner-vps"
  totalElapsedMs?: number;
  planDurationMs?: number;
  finalUploadMs?: number;
  chunkRenderMs?: { count: number; totalMs: number; avgMs: number; maxMs: number; lastMs: number };
  [key: string]: unknown;
}

export interface RenderJobStatus {
  status: RenderStatus;
  progress: number;
  outputKey?: string;
  error?: string;
  workerPoolSize?: number;
  totalFrames?: number;
  metrics?: RenderMetrics;
}

export interface StartRenderOptions {
  compositionId: string;          // see composition table — always explicit
  inputProps: Record<string, unknown>;
  outputKey: string;
  idempotencyKey: string;
}

export function renderServerUrl(): string {
  const url = process.env.RENDER_SERVER_URL;
  if (!url) throw new Error("RENDER_SERVER_URL is not set");
  return url.replace(/\/$/, "");
}

function authHeaders(): Record<string, string> {
  const token = process.env.RENDER_SERVER_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function startRender(options: StartRenderOptions): Promise<string> {
  const res = await fetch(`${renderServerUrl()}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(options),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Render server error ${res.status}: ${text}`);
  }
  const job = (await res.json()) as { renderJobId: string };
  return job.renderJobId;
}

export async function getRenderStatus(renderJobId: string): Promise<RenderJobStatus> {
  const res = await fetch(
    `${renderServerUrl()}/jobs/${encodeURIComponent(renderJobId)}`,
    { headers: authHeaders() },
  );
  if (!res.ok) throw new Error(`Render status poll failed: ${res.status}`);
  return res.json() as Promise<RenderJobStatus>;
}

/** Public URL of a finished render. */
export function getRenderOutputUrl(renderJobId: string, outputKey: string): string {
  const base = process.env.CLOUDFLARE_R2_EXPORT_PUBLIC_URL ?? "";
  return base
    ? `${base.replace(/\/$/, "")}/${outputKey}`
    : `${renderServerUrl()}/jobs/${encodeURIComponent(renderJobId)}/output`;
}
```

---

## 5. Integration pattern (start → poll → save → progress bar)

Works in any background-job system (Inngest, BullMQ, plain API route + cron).
The shape every app should follow:

```typescript
import { startRender, getRenderStatus, getRenderOutputUrl } from "@/lib/render-server";

// 1) START — from the API route / job that kicks off a render
const renderJobId = await startRender({
  compositionId: "render",                       // this product's composition
  inputProps: { /* same props the <Player> preview uses */ },
  outputKey: `renders/${videoId}/output.mp4`,    // per-product prefix, stable per video
  idempotencyKey: `myapp:${videoId}`,            // see rules below
});
// persist renderJobId on the video record, set status "rendering", progress 5

// 2) POLL — every 10 s, up to 90 attempts (15 min: covers queue wait + render)
for (let attempt = 0; attempt < 90; attempt++) {
  await sleep(10_000);
  const status = await getRenderStatus(renderJobId);

  if (status.status === "failed") {
    // persist status "error"; surface status.error; refund credits if the app charges them
    throw new Error(`Render failed: ${status.error ?? "unknown"}`);
  }
  if (status.status === "completed" && status.outputKey) {
    const videoUrl = getRenderOutputUrl(renderJobId, status.outputKey);
    // persist { status: "completed", progress: 100, videoUrl }
    break;
  }
  // 3) PROGRESS BAR — persist status.progress (0-100) to the DB; the frontend
  // polls the app's own status endpoint and renders the bar. Optional step
  // labels: queued→"Waiting in render queue…", planning→"Preparing…",
  // rendering→"Rendering your video…", combining→"Finalizing…"
  await persistProgress(Math.max(5, status.progress));
}
```

**Idempotency key rules** (this is what makes retries safe):
- Stable per *logical render* — e.g. `short:<shortId>` or `export:<jobId>`.
  A retry of the same job MUST reuse the same key.
- Reposting the same key returns the **same** `renderJobId` while the job is
  queued/running/completed — no duplicate renders, no double billing.
- If the previous attempt **failed**, the same key creates a **fresh** job —
  so retry-after-failure works without changing the key.
- A *re-render with changed content* needs a NEW key (append a content hash or
  timestamp), otherwise you'll get the old completed job back.

**Error handling:**
- `429` from POST /jobs = queue full → back off and retry (job systems'
  step retry handles this naturally).
- Poll `!res.ok` → throw and let the job system retry the poll step.
- Timeout after 15 min of polling → mark the video errored; the server's own
  watchdog kills the render at 15 min too, so nothing keeps burning.
- Server restarts mark in-flight jobs `failed` (with a clear error message);
  the retry + idempotency rules above recover automatically.

**outputKey conventions:** prefix per product so one bucket serves all apps —
`renders/<id>/output.mp4` (shortshero shorts),
`shortshero/publish_<id>.mp4` (shortshero exports); new apps should use
`<appname>/<videoId>.mp4`. Same key = overwrite (fine for re-exports of the
same video; use a new key if old versions must stay downloadable).

---

## 6. Adding a NEW SaaS product/composition

1. In `/Volumes/Files/programming/render-hetzner/`: add the composition
   component under `src/compositions/`, register it in
   `src/remotion-entry.tsx` with a unique `id` (this becomes the
   `compositionId`) — use `calculateMetadata` to derive
   `durationInFrames`/`fps` from `inputProps`.
2. Keep the app's preview and the server in sync: the app's `<Player>` must
   render the same component with the same props (`@remotion/player` version
   pinned to the server's `remotion` version — currently **4.0.459**).
3. Redeploy the server (the bundle is baked at Docker build time):
   `ssh` to the VPS → `cd render-hetzner && git pull && docker compose up -d --build`
4. In the app: follow §3–§5 with the new `compositionId`.

---

## 7. Verify the integration (checklist)

```bash
# Server reachable + queue state (no auth)
curl -s https://render.yourdomain.com/health

# Auth works (expect 401 without token, 202 with)
curl -s -X POST https://render.yourdomain.com/jobs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RENDER_SERVER_TOKEN" \
  -d '{"compositionId":"render","inputProps":{...real props...},"outputKey":"test/agent-check.mp4","idempotencyKey":"agent-test-1"}'

# Poll until completed, then confirm the MP4 is publicly reachable
curl -s https://render.yourdomain.com/jobs/<renderJobId>
curl -sI <R2 public base>/test/agent-check.mp4   # expect 200 + video/mp4
```

Then run the app's real flow end-to-end once (trigger → progress bar moves →
video plays from the final URL). Delete the `test/` object afterwards.

---

## 8. Server deploy & ops (reference — usually already running)

Full instructions: `/Volumes/Files/programming/render-hetzner/README.md`.
Short version: `setup-vps.sh` on a fresh Ubuntu 24.04 Hetzner CX box → DNS A
record → `cp .env.example .env` (domain, token, R2 creds) →
`docker compose up -d --build`. Tuning knobs live in the VPS `.env`:
`RENDER_MEDIA_CONCURRENCY=8`, `MAX_PARALLEL_JOBS=1`, optional
`RENDER_X264_PRESET=faster`; benchmark with
`docker compose exec render-server npx remotion benchmark --concurrencies=4,6,8,10 build <compositionId>`.
Logs: `docker compose logs -f render-server`. The box is stateless (outputs in
R2) — rebuild from scratch ≈ 15 min.

Optional per-render cost tracking: renders report
`metrics.provider === "hetzner-vps"`; cost ≈
`metrics.totalElapsedMs / 3_600_000 × 0.0264` EUR (shortshero implements this
in `lib/render-cost.ts` → `computeVpsRenderCost`).

---

## 9. Reference implementation — the exact changes made in shortshero

shortshero (`/Volumes/Files/programming/shortshero`) was migrated on
2026-07-19 and is the worked example. **To integrate another app, replicate
this change set** (adapted to that app's job system and composition).

### 9.1 New files added in shortshero

| File | What it is |
|---|---|
| `lib/render-server.ts` | The client from §4, plus a rollback fallback: `renderServerUrl()` returns `RENDER_SERVER_URL ?? CLOUDFLARE_RENDER_WORKER_URL`, so deleting one env var switches back to the legacy Cloudflare worker. Copy this file into each app. |
| `render/src/vps-server.ts` | The render server itself (same code now running from `render-hetzner/src/vps-server.ts`). Express :8080; FIFO queue (`MAX_PARALLEL_JOBS=1`); one warm Chromium shared across jobs; whole-video `renderMedia()` at `concurrency: 8`; timing-safe bearer auth; idempotency dedupe; disk journal (`/render-tmp/jobs.json`) for crash recovery; 15-min watchdog; 429 backpressure past 50 queued jobs; direct R2 multipart upload via `@aws-sdk/lib-storage`; 24 h job retention; shutdown force-exits after 10 s if Chromium wedges. |
| `render/Dockerfile.vps` | node:22-bookworm-slim + Chromium system libs; `npx remotion browser ensure` + `npx remotion bundle` at **build** time → container boots warm. (= `render-hetzner/Dockerfile`) |
| `render/docker-compose.vps.yml` | render-server (14 GB mem cap, log rotation, loopback-only port) + Caddy auto-TLS. (= `render-hetzner/docker-compose.yml`) |
| `render/Caddyfile`, `render/.env.vps.example`, `render/setup-vps.sh`, `render/DEPLOY-VPS.md` | TLS proxy config, env template, one-time Ubuntu box setup (Docker, ufw 22/80/443, 4 GB swap), deploy guide. All mirrored in `render-hetzner/`. |
| `plan.md` | The migration plan that was implemented. |

### 9.2 Files modified in shortshero (the app-side integration diff)

| File | Change — replicate the equivalent in each app |
|---|---|
| `inngest/functions/renderVideo.ts` | Replaced raw `fetch` to the Cloudflare worker with `startRender()` / `getRenderStatus()` / `getRenderOutputUrl()` from `lib/render-server.ts` (this is what adds the bearer token). Poll ceiling raised 10 → 15 min (90 × 10 s) because jobs can wait in the VPS queue. Progress writing to Mongo unchanged — the frontend bar needed **zero** changes. |
| `inngest/functions/exportVideo.ts` | Same helper switch. User-facing step labels made queue-aware: `queued` → "Waiting in render queue…", `rendering` → "Rendering your video…", `combining` → "Finalizing your video…". Still sends `targetChunkCount` (VPS ignores it; legacy worker uses it during rollback). |
| `lib/cloudflare-render.ts` | Reduced to a compatibility shim re-exporting `lib/render-server.ts` under the old names (`startCloudflareRender`, `CloudflareRenderJobStatus`, …) so untouched imports (admin routes, cost code) keep compiling. Only needed in apps that previously used the Cloudflare worker. |
| `lib/render-cost.ts` | Added `computeVpsRenderCost()`: cost = wall-clock hours × €0.0264 (env override `RENDER_VPS_EUR_PER_HOUR`), currency `EUR`, `instances: 1`. |
| `lib/saveRenderCost.ts` | Branches on `status.metrics.provider === "hetzner-vps"` → VPS cost model; otherwise the old Cloudflare container model. Optional — only if the app tracks per-render cost. |
| `render/package.json` | Added `@aws-sdk/client-s3` + `@aws-sdk/lib-storage`; script `"vps": "node --experimental-strip-types --no-warnings src/vps-server.ts"`. |

### 9.3 Env vars added to shortshero's hosting env

```env
RENDER_SERVER_URL=https://render.<domain>    # remove → rolls back to Cloudflare
RENDER_SERVER_TOKEN=<same value as the VPS>
# already existed — R2 public base where finished MP4s are served:
CLOUDFLARE_R2_EXPORT_PUBLIC_URL=https://<public-r2-domain>
```

### 9.4 Per-app integration checklist (derived from the shortshero diff)

For each app (vidshero, vidgpt, blog-template, …):

1. Copy §4's client into the app as `lib/render-server.ts`.
2. Add the §3 env vars to the app's hosting env.
3. In the app's render/export background job: replace the old render call with
   the §5 start → poll → progress pattern, using that app's `compositionId`
   from the §1 table and an `outputKey` prefixed `<appname>/`.
4. Make sure the composition the app previews with `<Player>` is registered in
   `render-hetzner/src/remotion-entry.tsx` (§6) and `@remotion/player` matches
   the server's Remotion version (**4.0.459**).
5. Optional: cost tracking per §8.
6. Run the §7 verification checklist end-to-end.

### 9.5 Verified / not verified

Verified at implementation time (shortshero): typecheck clean; live API smoke
test (health, 401 without token, 202 create, idempotent repost → same id, 404
unknown job); crash recovery (restart marks in-flight job failed, same
idempotency key then creates a fresh job); shutdown force-exits ≤ 10 s with a
wedged Chromium. **Not verified locally:** an actual frame render (needs the
Linux/Docker box) — run §7 as the first step after deploy.
