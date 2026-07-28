// These must match the constants in lib/video-generation.ts
const DEFAULT_FPS = 30;
const DEFAULT_CLIP_PADDING_FRAMES = 10;

export type TimelineItem = {
  startMs: number;        // clip start in composition ms — authoritative for caption mapping
  startFrame: number;     // derived from startMs, used for Remotion Sequence `from`
  durationFrames: number; // total visual span (audio + padding for photos)
  audioFrames: number;    // audio-only span (no padding)
  isVideo: boolean;
};

/**
 * Single source of truth for all clip timing.
 *
 * Key rule: accumulate time as floating-point milliseconds; convert to frames
 * ONCE per clip via Math.floor. Never accumulate integers mid-loop.
 * This eliminates per-clip rounding drift that diverges between browser
 * preview (tolerant) and FFmpeg/Lambda render (frame-exact).
 */
export function buildTimeline(
  clipDurations: number[],
  clipTypes: Array<"photo" | "video">,
  fps: number = DEFAULT_FPS,
  clipPaddingFrames: number = DEFAULT_CLIP_PADDING_FRAMES,
): TimelineItem[] {
  const items: TimelineItem[] = [];
  let currentTimeMs = 0; // float accumulator — never rounded

  for (let i = 0; i < clipDurations.length; i++) {
    const isVideo = clipTypes[i] === "video";
    const audioTimeMs = clipDurations[i] * 1000;
    const paddingMs = isVideo ? 0 : (clipPaddingFrames / fps) * 1000;

    // Convert to frames exactly once — positions derived from float ms
    const startFrame = Math.floor((currentTimeMs / 1000) * fps);
    const audioEndFrame = Math.floor(((currentTimeMs + audioTimeMs) / 1000) * fps);
    const endFrame = Math.floor(((currentTimeMs + audioTimeMs + paddingMs) / 1000) * fps);

    items.push({
      startMs: currentTimeMs,
      startFrame,
      durationFrames: Math.max(1, endFrame - startFrame),
      audioFrames: Math.max(1, audioEndFrame - startFrame),
      isVideo,
    });

    currentTimeMs += audioTimeMs + paddingMs; // float — no rounding
  }

  return items;
}

/** Total composition duration in frames from a timeline. */
export function timelineDurationFrames(timeline: TimelineItem[]): number {
  if (timeline.length === 0) return 0;
  const last = timeline[timeline.length - 1];
  return last.startFrame + last.durationFrames;
}
