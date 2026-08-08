# render-hetzner — self-hosted Remotion render server

One Hetzner CX53 VPS (16 vCPU / 32 GB, ~€34.99/mo flat) that renders videos for
**all** the video SaaS apps (shortshero, vidshero, vidgpt, weddings, blog
templates…). This is the Hetzner counterpart of the `../render` folder's
Cloudflare Containers pipeline — same compositions, same HTTP contract, but one
box instead of a container fleet.

**How it uses the 16 cores:** no chunking. One `renderMedia()` call per job with
`concurrency: 16` (16 browser tabs capturing frames in parallel while ffmpeg
encodes concurrently), a FIFO queue in front, one warm Chromium reused across
jobs, the Remotion bundle baked at Docker build time, and the finished MP4
uploaded straight to R2.

## Compositions

All compositions from `src/remotion-entry.tsx` are servable; pick one per job
with `compositionId`:

| compositionId | Product |
|---|---|
| `vidshero` (default) | vidshero full videos |
| `render` | shortshero shorts/exports |
| `vidgpt` | vidgpt videos |
| `WeddingVideo` | wedding videos |
| `blog-template` | blog-to-video templates |

Edit compositions → rebuild the image (the bundle is baked at build time):
`git pull && docker compose up -d --build`.

## HTTP API (what each SaaS app calls)

All `/jobs` endpoints require `Authorization: Bearer <RENDER_SERVER_TOKEN>`.

```
POST /jobs
  { "compositionId": "render", "inputProps": {...},
    "outputKey": "renders/abc/output.mp4", "idempotencyKey": "short:abc" }
  → 202 { "renderJobId": "...", "status": "queued" }

GET /jobs/:id                (poll every ~10 s)
  → { "status": "queued|planning|rendering|combining|completed|failed",
      "progress": 0-100, "outputKey"?, "error"?, "totalFrames"?, "metrics"? }

GET /jobs/:id/output         → 302 to R2 public URL
POST /jobs/:id/cancel        → cancels an in-flight render
GET /health                  → liveness + queue depth (no auth)
```

Reposting the same `idempotencyKey` returns the existing job — unless it
failed, in which case a fresh attempt is created (safe for queue/retry systems
like Inngest). A ready-made typed client for Next.js apps lives in
`shortshero/lib/render-server.ts` — copy it into each SaaS.

Progress bar: poll `GET /jobs/:id` and show `progress`. Statuses map to
"waiting in queue" (queued), "preparing" (planning), "rendering" (3–96 %),
"finalizing/upload" (combining, 97–99), done (completed, 100).

## Deploy to the VPS

1. **Provision:** Hetzner CX53 16 vCPU / 32 GB, Ubuntu 24.04, SSH key. Then:
   `scp setup-vps.sh root@<ip>:/root/ && ssh root@<ip> bash setup-vps.sh`
   (Docker, firewall 22/80/443, 8 GB swap, unattended upgrades.)
2. **DNS:** A record `render.yourdomain.com` → VPS IP (Caddy auto-TLS).
3. **Configure & start:**
   ```bash
   git clone <this repo> render-hetzner && cd render-hetzner
   cp .env.example .env
   openssl rand -hex 32        # → RENDER_SERVER_TOKEN
   nano .env                   # domain, token, R2 credentials
   docker compose up -d --build
   curl -s https://render.yourdomain.com/health
   ```
4. **Point each SaaS app at it:**
   ```env
   RENDER_SERVER_URL=https://render.yourdomain.com
   RENDER_SERVER_TOKEN=<same token>
   ```

## Tune once after deploy

```bash
docker compose exec render-server npx remotion benchmark --concurrencies=8,12,16,20 build <compositionId>
```

Set the winner as `RENDER_MEDIA_CONCURRENCY` in `.env`, `docker compose up -d`.
If verbose logs show encoding (not frame capture) is the bottleneck, set
`RENDER_X264_PRESET=faster`.

## Operations

- **Logs:** `docker compose logs -f render-server`
- **Uptime:** point a monitor at `GET /health`.
- **Crash recovery:** in-flight jobs are journaled to disk; after a restart
  they're marked `failed` and the caller's retry re-submits them.
- **Stateless:** outputs live in R2 — a dead box is rebuilt in ~15 min
  (steps 1–3), nothing to back up.
- **Version pinning:** keep `remotion`/`@remotion/renderer` here in lockstep
  with each app's `@remotion/player` (currently 4.0.459).
