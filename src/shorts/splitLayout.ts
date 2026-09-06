/**
 * Split-screen geometry for auto B-roll — the single definition of it.
 *
 * A cutaway clip carrying `split: "bottom" | "top"` does not overlay the
 * speaker: it takes half the frame and the speaker takes the other half, both
 * at full width. `"bottom"` means the cutaway sits under the speaker.
 *
 * This lives in its own module because the geometry is shared by two separate
 * copies of the composition — `components/RemotionShortPlayer.tsx` (browser
 * preview) and `render/src/compositions/ShortVideo.tsx` (the render server). If
 * the two ever disagree, the preview lies about what the download contains. The
 * render server is a separate package that cannot import across the boundary, so
 * it keeps a byte-identical copy; this module is the reference for that copy.
 */

export type SplitSide = "top" | "bottom";

/** The half of the frame the cutaway occupies. */
export function splitBox(split: SplitSide): React.CSSProperties {
  return split === "top"
    ? { position: "absolute", left: 0, right: 0, top: 0, height: "50%", overflow: "hidden" }
    : { position: "absolute", left: 0, right: 0, bottom: 0, height: "50%", overflow: "hidden" };
}

/** Where the main video goes. `null` = no cutaway on screen, so it fills the frame. */
export function mainBox(split: SplitSide | null): React.CSSProperties {
  if (!split) return { position: "absolute", inset: 0 };
  // Cutaway on the bottom -> speaker takes the top half, and vice versa.
  return split === "bottom"
    ? { position: "absolute", left: 0, right: 0, top: 0, height: "50%", overflow: "hidden" }
    : { position: "absolute", left: 0, right: 0, bottom: 0, height: "50%", overflow: "hidden" };
}

// ─── Multi-speaker stacks ────────────────────────────────────────────────────
//
// A face-tracked clip can arrive with two, three or four speakers already
// stacked into the frame by ffmpeg (see lib/facetrack.ts). The composition does
// not lay that out — it plays the pre-cropped file — but it does have to know
// where the seams are, because that is where the captions go.

/**
 * The seam a stack of `slots` speakers puts its captions on, as a fraction of
 * frame height.
 *
 * Two bands and a 2x2 grid both seam across the middle. Three bands seam at a
 * third and two thirds, and the captions take the LOWER one: it is nearest the
 * height captions sit at on an unstacked clip, so they move the least when the
 * source cuts in and out of the stack, and it leaves the top two speakers — the
 * two the eye reads first — completely clear.
 *
 * Anything unrecognised falls back to the middle, which is what every stacked
 * clip written before the stack could hold more than two people was.
 */
export function stackSeamY(slots: number | null | undefined): number {
  return slots === 3 ? 2 / 3 : 0.5;
}

/**
 * The seam the HOOK TITLE sits on in a stacked clip, as a fraction of frame
 * height.
 *
 * A hook normally rides near the top of the frame, which is correct on an
 * ordinary clip — nothing is up there but headroom. On a stack it is not: the
 * top band is a whole speaker, cropped to their face, and the headline lands
 * across their forehead. The seam is the one horizontal line in a stacked frame
 * that covers nobody, so that is where the hook goes.
 *
 * Two bands and a 2x2 of four both seam across the middle, and the hook takes
 * it. Three bands have TWO seams — a third and two thirds — so the hook takes
 * the upper one and the captions keep the lower one (see stackSeamY), and the
 * two never have to negotiate. Only the two-band and four-up cases have a
 * single seam that both want; RemotionShortPlayer resolves that by dropping the
 * captions back to the bottom for as long as the hook is on screen.
 */
export function hookSeamY(slots: number | null | undefined): number {
  return slots === 3 ? 1 / 3 : 0.5;
}

/** The split of whichever cutaway covers `frame`, or null when none does. */
export function activeSplitAt(tracks: unknown[], frame: number): SplitSide | null {
  for (const t of tracks) {
    const track = t as { visible?: boolean; clips?: unknown[] };
    if (track?.visible === false || !Array.isArray(track?.clips)) continue;
    for (const c of track.clips) {
      const clip = c as { split?: string; startFrame?: number; durationFrames?: number };
      if (clip?.split !== "top" && clip?.split !== "bottom") continue;
      const from = clip.startFrame ?? 0;
      const to = from + Math.max(1, clip.durationFrames ?? 30);
      if (frame >= from && frame < to) return clip.split;
    }
  }
  return null;
}

// ─── Keeping the face in frame during a split ────────────────────────────────
//
// The speaker's clip is 9:16 (1080x1920) and mainBox() gives it a 1080x960 box.
// `object-fit: cover` then shows exactly half the clip's height — and the CSS
// default, `object-position: 50% 50%`, picks the MIDDLE half: rows 480..1440.
//
// Talking heads do not live there. Measured on the TEDx clip that surfaced this:
// the face sits at y≈0.20 of frame height, i.e. row ~380 — entirely above the
// centre window, so the split showed a necktie and the top of a chin. Every
// centred talking-head crop has this problem; the face is above the midline
// essentially always, because framing leaves the body in the lower half.
//
// So anchor the visible window on the face instead of the frame centre.

/** Fallback vertical face position for clips face tracking never measured. */
export const DEFAULT_FACE_FOCUS_Y = 0.25;

/**
 * Where the face should land inside the half-height box, 0 (top edge) to 1
 * (bottom edge). Slightly above centre: that leaves headroom above the face and
 * puts the shoulders, not empty background, along the split line.
 */
const FACE_TARGET_IN_BOX = 0.42;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * `object-position` for the speaker's video inside mainBox().
 *
 * Derivation — `cover` scales the 9:16 clip to the box width, so the box shows a
 * fraction `r` of the clip's height (r = 0.5 for a half-height box). CSS aligns
 * the `p` point of the image with the `p` point of the box, which puts the top
 * of the visible window at `p * (1 - r)` in clip coordinates. Requiring the face
 * at `f` to land at `FACE_TARGET_IN_BOX` (= a) within that window:
 *
 *     p * (1 - r) + a * r = f   ->   p = (f - a * r) / (1 - r)
 *
 * With r = 0.5 and a face at f = 0.20 this gives p ≈ 0, i.e. show the clip's top
 * half — which is exactly where the head is.
 *
 * @param split          the active cutaway side, or null when none is on screen
 * @param faceFocusY     measured face position (0..1); undefined falls back
 * @param verticalCrop   whether the box actually crops vertically. Only true for
 *                       a portrait source: a landscape clip scaled to a
 *                       half-height box is cropped horizontally, not
 *                       vertically, so there is no vertical window to aim and
 *                       the formula's (1 - r) would be zero.
 */
export function mainObjectPosition(
  split: SplitSide | null,
  faceFocusY: number | null | undefined,
  verticalCrop: boolean
): string {
  if (!split || !verticalCrop) return "50% 50%";
  const r = 0.5; // mainBox is always half the frame height
  const f = clamp01(typeof faceFocusY === "number" && isFinite(faceFocusY) ? faceFocusY : DEFAULT_FACE_FOCUS_Y);
  const p = clamp01((f - FACE_TARGET_IN_BOX * r) / (1 - r));
  return `50% ${(p * 100).toFixed(2)}%`;
}
