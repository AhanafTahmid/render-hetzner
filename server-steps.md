# Server setup runbook — render-hetzner on a fresh Hetzner VPS

Step-by-step to stand up the render server on a new box, exactly as it was done
(and debugged) the first time. Follow top to bottom. Anything marked **⚠️** is a
mistake we hit the first time — don't repeat it.

**Reference values used last time** (change IP/token as needed):

| Thing | Value |
|---|---|
| Box | Hetzner **CX53**, 16 vCPU / 32 GB / 320 GB, Ubuntu 24.04+, Nuremberg |
| Current server IP | `23.88.97.74` |
| Render server domain | `render-api.vidshero.com` (A → VPS, **grey cloud**) |
| Older server IPs (deleted) | `157.180.17.218` |
| Older domain (parked, unused) | `render.postzen.app` — `postzen.app` sits on registrar lander NS, not Cloudflare |
| R2 exports bucket | **`render`** → served at BOTH `https://render.shortshero.com` and `https://render.vidshero.com` (two custom domains, one bucket) |
| R2 source-assets buckets | `shortshero` → `https://cdn.shortshero.com` · `vidshero` → `https://cdn.vidshero.com` |
| Repo | `git@github.com:AhanafTahmid/render-hetzner.git` (private) |

**⚠️ The render server domain and the R2 export domain are different hostnames on
the same zone.** `render.vidshero.com` is an R2 custom domain (orange cloud) and
must stay bound to the bucket — every `exportUrl`/`videoUrl` in Mongo is an
absolute URL under it. The render API gets its own name (`render-api`), grey cloud.

---

## 0. Prerequisites (do BEFORE touching the box)

### 0a. DNS — point the render subdomain at the new box
In Cloudflare, add an A record:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `render-api` (→ `render-api.vidshero.com`) | `23.88.97.74` | **DNS only (grey cloud)** |

Do **not** add an AAAA record unless the box is verified to serve on IPv6 — Let's
Encrypt may prefer it, fail the challenge, and block issuance even though IPv4 works.

**⚠️ Grey cloud is mandatory.** Caddy gets a Let's Encrypt cert via an HTTP-01
challenge on port 80. If the record is orange-clouded (proxied), Cloudflare
intercepts 80/443 and the challenge fails → no HTTPS. (This is the *opposite* of
the R2 custom-domain records below, which ARE proxied — don't confuse them.)

Verify it's live and grey before continuing:
```bash
dig +short @1.1.1.1 render-api.vidshero.com A   # must return the raw VPS IP
```

### 0b. Confirm the R2 buckets + custom domains exist
This is the thing that cost us the most time. One **exports** bucket is shared by
every app; each app has its own **source-assets** bucket:

- **`render`** bucket → holds finished exports. Two custom domains front it:
  **`render.shortshero.com`** and **`render.vidshero.com`**. Each app reads its own.
- **`shortshero`** bucket → **`cdn.shortshero.com`** → shortshero source uploads.
- **`vidshero`** bucket → **`cdn.vidshero.com`** → vidshero source uploads.

Every app reads finished videos from its own `CLOUDFLARE_R2_EXPORT_PUBLIC_URL`,
all of which front the `render` bucket — so the render server MUST upload there.
**⚠️ Do NOT set `R2_BUCKET` to a source bucket** (`shortshero`/`vidshero`) — that
uploads to the wrong place and every finished video 404s for the app.

Verify a bucket→domain binding without the console by HEADing one known object
under each domain; both must return 200 for the same key.

If setting up in a new Cloudflare account, make sure both buckets exist and each
has its custom domain bound (R2 → bucket → Settings → Custom Domains).

---

## 1. Provision + verify the box

Create the Hetzner box, Ubuntu, your SSH key added at creation. The CCX line
(dedicated vCPU) is nicer for sustained 100% CPU rendering; the current box is a
**CX53** (shared vCPU) — cheaper, but watch for CPU steal under long renders
(`vmstat 1`, the `st` column) and move to CCX if it's consistently non-zero.

SSH in and sanity-check the specs BEFORE building — the `.env` assumes 16 cores:
```bash
ssh root@23.88.97.74
nproc                          # expect 16
free -g                        # expect ~32 GB
df -h /                        # expect ~320 GB
lscpu | grep "Model name"      # AMD EPYC / dedicated = CCX
```
**⚠️ If `nproc` < 16, stop and lower `RENDER_MEDIA_CONCURRENCY` to match** —
concurrency above the core count over-subscribes the box and renders get *slower*.

If you can't SSH with your key (Permission denied publickey), authorize your
local key using the box's root password (from Hetzner console / rescue reset):
```bash
ssh-copy-id -i ~/.ssh/<yourkey>.pub root@<NEW_IP>
```

---

## 2. Base setup (Docker, firewall, swap)

Git is needed to clone; a fresh cloud image may not have it:
```bash
apt-get update && apt-get install -y git
```

The repo is private, so give the box a **read-only deploy key**:
```bash
# on the VPS
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -C "render-hetzner-vps"
cat ~/.ssh/id_ed25519.pub
```
Add that public key to the repo: GitHub → repo **Settings → Deploy keys → Add**,
**leave "Allow write access" UNCHECKED**. (Or via gh CLI from your laptop:
`gh api repos/AhanafTahmid/render-hetzner/keys -f title="render-vps" -f key="<pubkey>" -F read_only=true`.)

Clone and run the base setup:
```bash
cd /root
ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts
GIT_SSH_COMMAND="ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes" \
  git clone git@github.com:AhanafTahmid/render-hetzner.git
cd render-hetzner
bash setup-vps.sh    # installs Docker, ufw (22/80/443), 8 GB swap, unattended-upgrades
```
Ignore the "Next steps" it prints at the end — those paths are stale; use this doc.

Verify:
```bash
docker --version && docker compose version
ufw status            # 22, 80, 443 allowed
swapon --show         # 8 GB swapfile
```

---

## 3. Create the `.env`

Create `/root/render-hetzner/.env`. **⚠️ The server's var names differ from the
app's** — map them carefully, and note `R2_BUCKET=render`:

```bash
RENDER_DOMAIN=render-api.vidshero.com
# Reuse the SAME token already in your apps' env (so you don't have to update
# every app). Generate a new one only if you also update it everywhere:
#   openssl rand -hex 32
RENDER_SERVER_TOKEN=<same token the apps use>

# From the shortshero app .env (different names!):
R2_ACCOUNT_ID=<app CLOUDFLARE_R2_ACCOUNT_ID>
R2_ACCESS_KEY_ID=<app CLOUDFLARE_R2_ACCESS_KEY_ID>
R2_SECRET_ACCESS_KEY=<app CLOUDFLARE_R2_SECRET_ACCESS_KEY>
R2_BUCKET=render                              # ⚠️ the EXPORTS bucket, NOT "shortshero"
R2_PUBLIC_URL=https://render.shortshero.com   # public domain of the render bucket

# Tuning (sized for 16 vCPU / 32 GB — CX53):
RENDER_MEDIA_CONCURRENCY=16
MAX_PARALLEL_JOBS=1
MAX_QUEUE_DEPTH=5     # ⚠️ keep low: app poll times out at 15 min; overflow should
                     # 429 (Inngest retries) rather than silently queue past the timeout
```
```bash
chmod 600 /root/render-hetzner/.env
```

Mapping cheat-sheet (server var ← app var):
| Server `.env` | ← shortshero app `.env` |
|---|---|
| `R2_ACCOUNT_ID` | `CLOUDFLARE_R2_ACCOUNT_ID` |
| `R2_ACCESS_KEY_ID` | `CLOUDFLARE_R2_ACCESS_KEY_ID` |
| `R2_SECRET_ACCESS_KEY` | `CLOUDFLARE_R2_SECRET_ACCESS_KEY` |
| `R2_BUCKET` | **`render`** (literal — not `CLOUDFLARE_R2_BUCKET_NAME`) |
| `R2_PUBLIC_URL` | `CLOUDFLARE_R2_EXPORT_PUBLIC_URL` (`https://render.shortshero.com`) |

---

## 4. Build and start

```bash
cd /root/render-hetzner
docker compose up -d --build     # first build ~5–10 min (Chromium + Remotion bundle baked in)
```

Verify HTTPS + cert (from your laptop):
```bash
curl -s https://render-api.vidshero.com/health
# {"status":"ok",...,"queueDepth":0,"concurrency":16}
```
If TLS fails: `docker compose logs caddy` — almost always DNS not propagated yet
or an orange cloud (see step 0a).

---

## 5. Smoke test (prove the pipeline before touching apps)

```bash
TOKEN=$(grep '^RENDER_SERVER_TOKEN=' /root/render-hetzner/.env | cut -d= -f2)
# Source clips live in the shortshero bucket → cdn.shortshero.com:
SRC="https://cdn.shortshero.com/uploaded-videos/1779630521199-clip.mp4"

RESP=$(curl -s -X POST https://render-api.vidshero.com/jobs \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"compositionId\":\"render\",\"inputProps\":{\"videoUrl\":\"$SRC\",\"startTime\":0,\"endTime\":5,\"captions\":\"[]\",\"captionStyle\":{},\"showWatermark\":false},\"outputKey\":\"renders/smoke/output.mp4\",\"idempotencyKey\":\"smoke-$(date +%s)\"}")
echo "$RESP"
JOB=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['renderJobId'])")

# poll until completed:
curl -s https://render-api.vidshero.com/jobs/$JOB -H "Authorization: Bearer $TOKEN"
```
Expect `status: completed`, `metrics.provider: "hetzner-vps"`. Then confirm the
file is servable at the app-facing URL (**must be 200**):
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://render.shortshero.com/renders/smoke/output.mp4
```
**⚠️ If this 404s**, `R2_BUCKET` is wrong (should be `render`) or the custom domain
isn't bound. Delete the smoke object afterward if you care about tidiness.

---

## 6. Point the apps at the box

In each app's **production env** (Vercel, etc.) — same values across all apps:
```
RENDER_SERVER_URL=https://render-api.vidshero.com
RENDER_SERVER_TOKEN=<same token as the server .env>
```
- Leave `CLOUDFLARE_R2_EXPORT_PUBLIC_URL=https://render.shortshero.com` unchanged — it's correct.
- Leave `CLOUDFLARE_RENDER_WORKER_URL` in place as rollback (resolution is
  `RENDER_SERVER_URL ?? CLOUDFLARE_RENDER_WORKER_URL`; deleting `RENDER_SERVER_URL`
  instantly reverts to Cloudflare).

Each app selects its composition by `compositionId` when calling `startRender`:
`render` (shortshero), `vidshero`, `vidgpt`, `WeddingVideo`, `blog-template`.

Redeploy, export one video, confirm it plays from `render.shortshero.com` and the
saved render cost shows `provider: "hetzner-vps"` (EUR).

---

## 7. Operations

```bash
cd /root/render-hetzner
docker compose logs -f render-server     # live logs
docker compose ps                        # status
docker compose up -d --build             # redeploy after `git pull`
docker compose restart render-server     # restart (picks up .env changes if recreated)
```
- Both stacks auto-start on reboot (`restart: unless-stopped`).
- Outputs live in R2 — the box is stateless; a dead box rebuilds in ~15 min by
  redoing steps 1–4. Nothing to back up.
- Uptime: point a monitor at `GET /health` (unauthenticated).
- Keep `remotion`/`@remotion/renderer` here in lockstep with each app's
  `@remotion/player` (currently `4.0.459`).

---

## 8. (Optional) Zabbix CPU monitoring

Separate Docker stack in `/root/zabbix/`, web UI bound to localhost only.

`/root/zabbix/.env`:
```
POSTGRES_PASSWORD=<openssl rand -hex 16>
```

`/root/zabbix/docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment: { POSTGRES_USER: zabbix, POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}, POSTGRES_DB: zabbix }
    volumes: [ pgdata:/var/lib/postgresql/data ]
    mem_limit: 512m
  zabbix-server:
    image: zabbix/zabbix-server-pgsql:alpine-7.0-latest
    restart: unless-stopped
    environment: { DB_SERVER_HOST: postgres, POSTGRES_USER: zabbix, POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}, POSTGRES_DB: zabbix }
    depends_on: [postgres]
    mem_limit: 512m
  zabbix-web:
    image: zabbix/zabbix-web-nginx-pgsql:alpine-7.0-latest
    restart: unless-stopped
    environment: { ZBX_SERVER_HOST: zabbix-server, DB_SERVER_HOST: postgres, POSTGRES_USER: zabbix, POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}, POSTGRES_DB: zabbix, PHP_TZ: UTC }
    ports: [ "127.0.0.1:8081:8080" ]
    depends_on: [postgres, zabbix-server]
    mem_limit: 256m
  zabbix-agent:
    image: zabbix/zabbix-agent2:alpine-7.0-latest
    restart: unless-stopped
    environment: { ZBX_SERVER_HOST: zabbix-server, ZBX_HOSTNAME: render-vps }
    depends_on: [zabbix-server]
    mem_limit: 128m
volumes: { pgdata: {} }
```

Bring up + register the host (agent CPU is host-wide because Docker doesn't
virtualize `/proc/stat`):
```bash
cd /root/zabbix && docker compose up -d
```
Then create the monitored host once, via the API (default login `Admin`/`zabbix`):
- `user.login` → token
- `hostgroup.get` name "Linux servers" → groupid
- `template.get` host "Linux by Zabbix agent" → templateid
- `host.create`: host `render-vps`, agent interface `type:1, useip:0, dns:"zabbix-agent", port:"10050"`, link the template + group

Access the UI:
```bash
ssh -i ~/.ssh/<yourkey> -L 8081:localhost:8081 root@<NEW_IP>
# then browse http://localhost:8081  (login Admin/zabbix — CHANGE the password)
```
CPU graphs: Monitoring → Latest data / Hosts → `render-vps`.
Note: containerized agent → CPU/memory/load are accurate (host-wide), but
per-filesystem **disk** metrics reflect the container, not host `/`.

---

## Gotchas we hit (summary)

1. **`R2_BUCKET` must be `render`, not `shortshero`.** Exports go to the `render`
   bucket served by `render.shortshero.com`; sources live in `shortshero`/`cdn`.
2. **Render subdomain = grey cloud; R2 custom domains = orange cloud.** Opposite settings.
3. **Private repo → deploy key**, and install `git` before cloning.
4. **`MAX_QUEUE_DEPTH=5`** so overflow 429s instead of silently blowing past the
   app's 15-min poll timeout.
5. **Perceived render time ≠ actual.** The app polls every 10s, inflating Inngest's
   reported wall-clock. Actual render (~52s for 30s of video on 8 cores at ~95%;
   expect roughly half that on the 16-core CX53) is
   in `metrics.totalElapsedMs`. Lower the poll interval in the app for snappier UX.
6. **Step labels are cosmetic.** `start-render`/`poll-render` in the app just name
   the trace; the backend is chosen by `RENDER_SERVER_URL`, not the label.
