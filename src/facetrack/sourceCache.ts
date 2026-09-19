/**
 * Keeps one copy of a source video on disk for all the clips cut from it.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * On the app box, face tracking cropped every clip of an import out of a single
 * file that had been downloaded once (`sharedInputPath` in the app's
 * cropProjectClip). Moving the work here would have quietly undone that: each
 * crop is its own HTTP job, so a ten-clip podcast would have pulled the same
 * source down ten times — and a long-form source is hundreds of megabytes, so
 * that is gigabytes of transfer and a download bolted onto the front of every
 * crop that used to cost nothing.
 *
 * So downloads are shared here instead, which is strictly better than what the
 * app box managed: the file is fetched on first use and reused by every worker
 * and every later clip, not just the ones inside one function call.
 *
 * ── Keying ──────────────────────────────────────────────────────────────────
 *
 * On the URL with its query string removed. Sources arrive presigned, and a
 * presigned URL carries an expiry and a signature that differ on every request
 * for the same object — keying on the whole URL would therefore never hit, and
 * would be a cache in name only. Path plus host identifies the object.
 *
 * ── Concurrency ─────────────────────────────────────────────────────────────
 *
 * The pool hands out work to several workers at once and they routinely start
 * on clips of the same source in the same instant, so the in-flight promise map
 * is what stops eight workers downloading the same file eight times. The
 * download lands on a temporary name and is renamed into place, so a reader can
 * never observe a half-written file even if this process dies mid-fetch.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** How long an unused source is kept before the sweeper removes it. */
const TTL_MS = Number(process.env.FACETRACK_SOURCE_TTL_MS ?? 2 * 60 * 60 * 1000);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.FACETRACK_SOURCE_TIMEOUT_MS ?? 600_000);

export class SourceCache {
  private readonly dir: string;
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(tmpDir: string) {
    this.dir = path.join(tmpDir, "facetrack-sources");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private keyFor(url: string): string {
    let identity = url;
    try {
      const u = new URL(url);
      // Signature and expiry live in the query string and change per request.
      identity = `${u.host}${u.pathname}`;
    } catch {
      // Not a URL we can parse — hash it whole rather than guess.
    }
    return crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32);
  }

  /** Local path of the source, downloading it first if this is its first use. */
  async get(url: string): Promise<string> {
    const key = this.keyFor(url);
    const dest = path.join(this.dir, `${key}.mp4`);

    // A previous clip already brought it down. Touch it so the sweeper measures
    // idleness from last USE, not from when it was fetched — otherwise a long
    // project loses its source halfway through.
    if (await this.isUsable(dest)) {
      const now = new Date();
      await fsp.utimes(dest, now, now).catch(() => {});
      return dest;
    }

    const running = this.inFlight.get(key);
    if (running) return running;

    const download = this.download(url, dest).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, download);
    return download;
  }

  private async isUsable(file: string): Promise<boolean> {
    try {
      return (await fsp.stat(file)).size > 0;
    } catch {
      return false;
    }
  }

  private async download(url: string, dest: string): Promise<string> {
    const tmp = `${dest}.${process.pid}.${Date.now()}.part`;
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok || !res.body) {
      throw new Error(`Failed to fetch source video (${res.status})`);
    }

    try {
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
                     fs.createWriteStream(tmp));
      if ((await fsp.stat(tmp)).size === 0) throw new Error("Downloaded source is empty");
      // Atomic: a reader sees either no file or the whole file.
      await fsp.rename(tmp, dest);
      return dest;
    } catch (err) {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  /** Removes sources nothing has touched for TTL_MS. */
  async sweep(): Promise<void> {
    const cutoff = Date.now() - TTL_MS;
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const file = path.join(this.dir, name);
      try {
        const st = await fsp.stat(file);
        if (st.mtimeMs < cutoff) await fsp.unlink(file);
      } catch {
        // Raced with another sweep or a download's rename — nothing to do.
      }
    }
  }
}
