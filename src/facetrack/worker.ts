/**
 * One face-tracking worker process.
 *
 * Reads jobs as JSON lines on stdin, writes one JSON line per finished job on
 * stdout. Long-lived: BlazeFace weights and the TensorFlow native addon cost
 * ~1-2 s to load, so a process-per-job would pay that on every clip.
 *
 * ── Why a separate process at all ───────────────────────────────────────────
 *
 * Two reasons, and the second is the important one.
 *
 * Throughput: BlazeFace inference runs on the Node main thread, so two
 * detections inside ONE process interleave on the event loop instead of using
 * two cores. The measured sweep that sized this pool forked processes for
 * exactly that reason.
 *
 * Blast radius: this is the work that used to OOM the app box and take the web
 * server down with it. A crop that runs away here kills a worker the pool
 * replaces, and the render server — including any render in flight and the HTTP
 * handler the app is waiting on — does not notice. Keeping TensorFlow out of
 * the server process is the whole point.
 */
import readline from "readline";
import { cropShortWithFaceTracking } from "./facetrack.ts";

export interface FacetrackWorkerJob {
  id: string;
  videoUrl: string;
  startTime: number;
  endTime: number;
  outputKey: string;
  /**
   * The source, already on local disk. The pool downloads it through the shared
   * source cache before dispatching, so every clip cut from one video reuses a
   * single copy instead of each worker fetching its own.
   */
  localPath?: string;
}

export interface FacetrackWorkerResult {
  id: string;
  ok: boolean;
  error?: string;
  url?: string;
  faceFocusY?: number;
  tracked?: boolean;
  speakerLayout?: string;
  speakerSlots?: number | null;
  stackedRanges?: { start: number; end: number }[];
  detectMs?: number;
  totalMs?: number;
}

const send = (r: FacetrackWorkerResult) => process.stdout.write("RESULT " + JSON.stringify(r) + "\n");

const rl = readline.createInterface({ input: process.stdin });

for await (const line of rl) {
  const text = line.trim();
  if (!text) continue;

  let job: FacetrackWorkerJob;
  try {
    job = JSON.parse(text) as FacetrackWorkerJob;
  } catch (err) {
    // A malformed line is a bug in the pool, not a job we can fail cleanly —
    // there is no id to report it against, so say so and keep serving.
    console.error("[facetrack-worker] unparseable job line:", (err as Error).message);
    continue;
  }

  const t0 = Date.now();

  try {
    // Passing localPath makes the pipeline treat the file as borrowed: it reads
    // it and leaves it alone, which is what lets the next clip of the same
    // source reuse it. Without it the pipeline downloads and then deletes.
    const out = await cropShortWithFaceTracking(
      job.videoUrl,
      job.startTime,
      job.endTime,
      job.outputKey,
      job.localPath,
    );

    send({
      id: job.id,
      ok: true,
      url: out.url,
      faceFocusY: out.faceFocusY,
      tracked: out.tracked,
      speakerLayout: out.speakerLayout,
      speakerSlots: out.speakerSlots ?? null,
      stackedRanges: out.stackedRanges,
      totalMs: Date.now() - t0,
    });
  } catch (err) {
    send({
      id: job.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      totalMs: Date.now() - t0,
    });
  }
  // No cleanup here on purpose: cropShortWithFaceTracking removes its own
  // output in a finally block, and the source belongs to the pool's cache,
  // which is shared with the other clips of this video.
}
