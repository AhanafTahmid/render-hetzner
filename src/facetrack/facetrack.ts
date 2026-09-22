/**
 * GENERATED — do not edit.
 *
 * Written by shortshero/scripts/sync-facetrack.mjs from lib/facetrack.ts.
 * Change the app's copy and re-run:
 *
 *   pnpm sync:facetrack     (then rebuild and redeploy the render server)
 */
/**
 * Face-centered 9:16 crop — per-frame speaker tracking.
 *
 * Two-pass committed center building:
 *   Pass 1: detect raw face centers per frame via BlazeFace
 *   Pass 2: back-fill confirmed switches to candidate's first appearance
 *           to eliminate the "flash of wrong content" gap.
 *
 * Uses the main-code.js encode pipeline (libx264 crf 20, preset fast) and
 * samples detection at DETECTION_FPS (4fps) for speed, then interpolates the
 * crop path back up to the source frame rate so the camera pans continuously
 * rather than in 4-per-second steps. Falls back to a blurred-background render
 * when too few frames contain a face.
 *
 * Camera motion (see CAMERA MOTION below): every timing constant is expressed
 * in SECONDS and converted to detection samples at runtime. main-code.js counts
 * raw frames instead, which is equivalent only because it detects at the source
 * frame rate — reusing its numbers here made every response 6-8x slower than
 * intended.
 *
 * Performance notes:
 *   - BlazeFace model is cached at module level (loaded once per process)
 *   - Encoding is async (spawn) so multiple clips can encode in parallel
 *   - detectFacesCropData + encodeWithCropData let callers pipeline:
 *       sequential detection (TF is CPU-bound) → parallel encoding
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
import path from "path";
import fs from "fs";
import { execSync, spawn } from "child_process";
import { describeExit, MemoryBudgetError, preferOomKill, watchRss } from "./oomVictim.ts";

// Node 23+ removed the long-deprecated util.isNullOrUndefined, which
// @tensorflow/tfjs-node@4.22.0 still calls internally. Restore it before tfjs
// is required (lazily, inside detectFacesCropData) so BlazeFace works on Node
// 23/24 too — otherwise detection throws and no facetracked clip is uploaded.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _util = require("util");
if (typeof _util.isNullOrUndefined !== "function") {
  _util.isNullOrUndefined = (v: unknown) => v === null || v === undefined;
}

// ─── Output config ──────────────────────────────────────────────────────────
const OUTPUT_W = 1080;
const OUTPUT_H = 1920;
// Detection frame size.
//
// This used to be a flat `DETECT_W = 112`, tuned on 1920×1080 sources. Because
// the height is derived from the source aspect ratio, a WIDER source collapses
// it: a 1920×960 (2:1) podcast crop detected at 112×56, where a face spans only
// a few pixels. Measured on podcast-clips/clip.mp4 (1920×960, 10s window, 40
// sampled frames):
//
//     DETECT_W=112  → 10/40 faces (25%)   detect 7.3s
//     DETECT_W=160  → 34/40 faces (85%)   detect 6.4s
//     DETECT_W=224  → 38/40 faces (95%)   detect 5.8s
//
// 25% is barely above BLUR_BG_FACE_THRESHOLD (10%), so that clip came within a
// whisker of silently losing face tracking and falling back to a blurred
// background. Note the bigger frames were also FASTER — more confident hits
// mean less work downstream, so the original "smaller is cheaper" premise did
// not hold here.
//
// So size by the SHORT edge instead: guarantee MIN_DETECT_H rows of pixels
// whatever the aspect ratio, with a floor on the width for tall sources.
const DETECT_W_MIN = 160;
const MIN_DETECT_H = 96;

/** Detection frame for a source, big enough for BlazeFace at any aspect ratio. */
function detectSize(srcW: number, srcH: number): { w: number; h: number } {
  // Width needed to give MIN_DETECT_H rows at this aspect ratio.
  const wForMinHeight = Math.ceil((srcW / srcH) * MIN_DETECT_H);
  const w = Math.max(2, Math.round(Math.max(DETECT_W_MIN, wForMinHeight) / 2) * 2);
  const h = Math.max(2, Math.round((srcH / srcW) * w / 2) * 2);
  return { w, h };
}
const MIN_SCORE = 0.75;
const DETECTION_FPS = 4;   // 4fps is sufficient for speaker tracking; was 6

// ─── Switching heuristics ────────────────────────────────────────────────────
const SWITCH_THRESHOLD            = 0.20;
const TRUE_CENTER_REL             = 0.5;
const BLUR_BG_FACE_THRESHOLD      = 0.10;

// ─── MULTI-UP: the multi-speaker stack ───────────────────────────────────────
//
// A podcast two-shot is the case the single-speaker camera handles worst. It
// picks one face and holds it, so every turn in the conversation is a cut, and
// the viewer spends the clip watching a camera make decisions instead of
// watching an exchange. When the speakers are ALL on screen for most of the
// clip, the better answer is to show all of them: each cropped to one slot of
// the output frame, in left-to-right reading order. No cuts, no decisions, and
// the reaction is on screen at the same time as the line that caused it.
//
// Two, three and four people are all handled, and the slot grid is the only
// thing that changes between them — see `slotGeometry`.
//
// This is baked into the face-tracked MP4 by ffmpeg rather than assembled in
// Remotion. The composition only ever plays the pre-cropped clip; building the
// stack in the composition would mean shipping the full landscape source to the
// browser and the render server and cropping it N times per frame. One encode
// here costs nothing extra and the preview and the export cannot disagree,
// because they play the same file.
//
// ── The stack is per-SEGMENT, not per-clip ──────────────────────────────────
//
// The first version asked one question of the whole clip — "are both speakers
// on screen for most of it?" — and stacked all of it or none of it. That is the
// wrong question for a real podcast master, because the master cuts. Measured
// on podcast-full.mp4 (1920x1080, 106s): single close-ups throughout except a
// wide two-shot from ~59s to ~67s. Probing a 55-75s window found both speakers
// together in 42% of frames, under the 55% bar, so the eight seconds that
// obviously wanted a stack got none — and probing the whole file put just 2 of
// its 24 samples inside the two-shot at all.
//
// So the plan now carries RANGES. Stretches where the speakers genuinely share
// the frame are stacked; everything else keeps the single-speaker camera, and
// ffmpeg switches between the two with an `overlay=...:enable='between(t,..)'`.
// A clip that is a group shot end to end still takes the old cheap path — one
// stack graph, no camera, no BlazeFace pass — because that is the same picture
// for less work.
//
// A clip with any stacked stretch is flagged `speakerLayout: "split"` and
// carries `stackedRanges` plus `speakerSlots` (how many people are in the
// stack). The composition reads the flag to know the clip has a stack in it,
// the ranges to know WHEN, and the slot count to know WHERE the seam is — so
// the captions sit on a band that covers no face for exactly the frames that
// are stacked, and at their normal height for the rest.
//
// ── One slot count per clip ─────────────────────────────────────────────────
//
// The number of slots is decided once for the whole clip and the ranges are the
// stretches that hold exactly that many people. A clip that is a three-shot for
// most of its length and a two-shot for eight seconds does NOT reflow to two
// bands for those eight seconds: it stacks the three-shot and runs the
// single-speaker camera over the rest. Reflowing would move every face on
// screen mid-sentence, which reads as a glitch, and it would move the captions
// with it.

/** The most people the stack can hold. Past this the clip is a crowd. */
const MULTI_UP_MAX_SLOTS = 4;
/** The fewest. One person is what the single-speaker camera is for. */
const MULTI_UP_MIN_SLOTS = 2;

/** Where one speaker's slot sits in the output frame, in output pixels. */
export interface SlotGeometry {
  cols: number;
  rows: number;
  slotW: number;
  slotH: number;
}

/**
 * The grid for `slots` speakers.
 *
 *   2 -> 1x2, two 1080x960 bands
 *   3 -> 1x3, three 1080x640 bands
 *   4 -> 2x2, four 540x960 cells
 *
 * Four goes to a grid rather than to four full-width bands because a 1080x480
 * band is a 2.25:1 letterbox per person — wide enough to hold both neighbours
 * and short enough to cut the head off at the eyebrows. A 2x2 cell is 540x960,
 * exactly 9:16, which is the shape a talking head already wants.
 *
 * Exported for the same reason as `planMultiUp`: the numbers below were tuned
 * against real footage and the geometry has to be re-derivable outside a render.
 */
export function slotGeometry(slots: number): SlotGeometry {
  const cols = slots >= 4 ? 2 : 1;
  const rows = slots >= 4 ? 2 : slots;
  return { cols, rows, slotW: OUTPUT_W / cols, slotH: OUTPUT_H / rows };
}

/**
 * How far apart two face clusters must sit, as a fraction of source width, to
 * be two people rather than one person plus detector jitter. 0.18 of a 1920px
 * source is ~345px — much wider than a head at podcast framing, and an order of
 * magnitude more than the ~29px of post-median jitter that CAMERA_DEADZONE_REL
 * is sized against.
 *
 * Applied to ADJACENT heads in left-to-right order, so it scales to a panel of
 * four the same way it worked for a pair.
 */
const MULTI_UP_MIN_SEPARATION = 0.18;
/**
 * The axis the speakers are separated along in the SOURCE.
 *
 * Not the axis of the output stack — that is always vertical bands (or a 2x2)
 * and is `slotGeometry`'s business. This is how the speakers are arranged in
 * the picture we are cropping out of, and everything downstream of the group
 * decision has to agree with it: which order the slots are read in, which
 * neighbour a crop window must stop before, and which coordinate says two
 * windows are showing different people.
 */
export type StackAxis = "x" | "y" | "grid";

/**
 * The same separation test as above, for speakers stacked VERTICALLY, as a
 * fraction of source HEIGHT.
 *
 * `MULTI_UP_MIN_SEPARATION` assumes the speakers sit side by side, which is the
 * shape of a podcast two-shot and of a panel master. It is not the shape of a
 * screen-share layout, where the shared window takes most of the frame and the
 * speakers go in a narrow rail down one side — every head in that rail sits at
 * essentially the SAME cx, so the horizontal test reads three people as one
 * person plus jitter and rejects every frame of the clip.
 *
 * Measured on the WATP source that surfaced this (1920x1080, three hosts in a
 * right-hand rail): the three heads sit within 0.03 of frame width of each
 * other and 0.31/0.32 of frame height apart. The horizontal test rejected all
 * of it; the clip then either fell back to the single-speaker camera or — worse
 * — latched onto the only pair that WAS horizontally separated, which was two
 * men inside the video being screen-shared.
 *
 * 0.16 of a 1080px source is 173px, against a head of ~126px there. A gap
 * wider than a whole head cannot be one head split in two, which is the same
 * thing the horizontal 0.18 buys on a 1920px source (345px against a ~124px
 * head at podcast framing). It also still admits a rail of four: four tiles
 * down 1080px sit ~0.25 of frame height apart.
 */
const MULTI_UP_MIN_SEPARATION_V = 0.16;
/**
 * How far a 2x2's estimated panel seam may sit from the exact half of the frame
 * and still be treated as an even split, as a fraction of the frame extent.
 *
 * The seam is inferred from where the faces sit, not from the picture, so it
 * carries whatever bias the speakers' own positions inside their panels give it
 * — a couple of percent on real footage. An even four-camera grid is by far the
 * common case and gets the exact half; 0.06 is comfortably wider than that bias
 * and comfortably narrower than any genuinely lopsided layout, which moves a
 * seam by a third of the frame, not a twentieth.
 */
const MULTI_UP_SEAM_SNAP = 0.06;
/**
 * How often frames may hold MORE people than the grid has slots, as a fraction
 * of the frames holding the group size that won the clip, before the clip is
 * treated as a crowd.
 *
 * Five people cannot go in four slots without framing somebody half out of
 * their box, so a crowd keeps the single-speaker camera — which follows
 * whoever is talking, and is what every tool in this category does with a
 * panel it cannot lay out.
 *
 * Same value and same reasoning as MULTI_UP_UPGRADE_FRAC: positive sightings
 * count, absences do not.
 */
const MULTI_UP_CROWD_FRAC = 0.55;
/**
 * How close a larger group has to come to the best group size to win the clip
 * anyway, as a fraction of that size's STACKED SECONDS.
 *
 * MoveNet loses a person for a sample when they lean out of frame, turn fully
 * away, or a hand crosses their face — so a genuine three-shot reports two
 * heads on a good fraction of its frames. Dropping somebody who is on screen is
 * much worse than including somebody who is quiet, so a larger group takes the
 * clip whenever it would put nearly as much stack on screen. Frames that saw N
 * people are positive evidence that N are there; frames that saw N-1 are not
 * evidence that the Nth is absent.
 *
 * Kept below 1 in the other direction too: a two-shot that a passer-by wanders
 * through for a few frames yields no run long enough to cut to, scores near
 * zero seconds, and stays a two-shot.
 */
const MULTI_UP_UPGRADE_FRAC = 0.55;
/**
 * Shortest stacked stretch worth cutting to, in seconds.
 *
 * The layout now changes with the source's own cuts, so this is the constant
 * that keeps it from strobing. Below ~1.5s a stack reads as a glitch rather
 * than as a shot, and the single-speaker camera is the better answer for it.
 */
const MULTI_UP_MIN_RUN_S = 1.5;
/**
 * Longest gap inside a group shot to bridge unconditionally, in seconds.
 *
 * MoveNet drops a person for a sample when they lean out of frame or a hand
 * crosses their face. Left alone that splits one continuous group shot into two
 * runs with a one-frame hole, and cutting out and back in for a third of a
 * second is exactly the strobing MULTI_UP_MIN_RUN_S exists to prevent.
 */
const MULTI_UP_GAP_MERGE_S = 1.2;
/**
 * Longest gap to bridge when the frames inside it PROVE the shot did not change,
 * in seconds.
 *
 * The unconditional window above is sized for a one-sample dropout, and that is
 * not the shape of the misses on a locked-off panel layout. Measured on the NFL
 * three-panel clip (1280x720, 70s, three men on screen essentially throughout):
 * MoveNet reports all three on 9 samples out of 70 and two of them on 21, in
 * bursts — so the stack came and went twice for a total of 10s of a 70s clip
 * that is a three-shot from end to end.
 *
 * Those gaps are not cuts, and the frames inside them say so: every head in
 * them sits within a jitter's width of where the group's heads sit, and is the
 * same size. A cut to a close-up looks nothing like that — the head moves and
 * roughly doubles. So a long gap is bridged only when every frame in it passes
 * that test (see `sameShot`), which is exactly the evidence the unconditional
 * window has to do without.
 *
 * Bridging cannot show content from elsewhere: the stack is a crop of the same
 * source at the same instant, so a bridged stretch shows those speakers'
 * windows of whatever is on screen. The only thing it can get wrong is
 * cropping a shot the windows were not measured on — which is what `sameShot`
 * rules out.
 */
const MULTI_UP_GAP_BRIDGE_S = 8.0;
/**
 * Floor for how far a head may sit from one of the group's head positions and
 * still be that person, as a fraction of source width.
 *
 * The tolerance itself is the speaker's OWN observed spread, capped by half the
 * smallest gap between two of the group's heads (see `posTol` in
 * buildStackRanges). This floor only matters for a speaker who barely moves,
 * where the measured spread is near zero and some room is still owed to
 * detector jitter.
 *
 * A fixed 0.05 was the first attempt and it was measured wrong. `FaceBox.cx` is
 * the centroid of whichever facial keypoints MoveNet is confident about, so it
 * moves when a head turns: on the NFL clip the left speaker's own cx ranged
 * 0.128-0.210 across frames where all three were detected — a spread of 0.082,
 * nearly twice the tolerance. One gap frame at 0.109 missed by 0.003 and cost
 * an 18s three-shot eight of its seconds.
 */
const MULTI_UP_SAME_SHOT_CX_FLOOR = 0.05;
/**
 * How much bigger or smaller a head may be than the group's heads and still be
 * the same shot.
 *
 * `FaceBox.h` comes from the ear-to-ear spread, which collapses as a head turns
 * away, so it is noisy even within one locked-off shot: on the NFL clip the
 * group frames themselves span 0.29-0.61 against a 0.51 median, a factor of
 * 1.76. 2.0 clears that. It still separates a cut cleanly — a close-up head on
 * podcast-full.mp4 is ~8x the wide shot's.
 */
const MULTI_UP_SAME_SHOT_H_RATIO = 2.0;
/** Total stacked time below which the clip is not worth treating as a group shot. */
const MULTI_UP_MIN_TOTAL_S = 2.0;
// "Is the whole clip a stack?" used to be a 0.9 coverage threshold and now lives
// in buildStackRanges, where the sampled frames are — see `whole` there for why
// a threshold could not answer it correctly.
/**
 * How much of one slot's height a face should fill, per slot count.
 *
 * Not one number, because the slots are not one shape. Two bands are 1080x960
 * and a head at 0.30 of that is 288px tall — the framing every two-speaker clip
 * has shipped with. Three bands are 1080x640, and 0.30 of that is a 192px head
 * adrift in a frame nearly six times as wide as it is tall; the band is short,
 * so the head has to be a bigger fraction of it to read as a portrait rather
 * than as a letterboxed slice of a room. 0.62 puts a 397px head in a 640px
 * band, which leaves headroom above and shoulders below and nothing else.
 *
 * The 2x2 cell is 540x960 — 9:16, the same shape as the whole output frame —
 * so it takes the same 0.30 that a full-height portrait crop would.
 */
const MULTI_UP_FACE_TARGET_H: Record<number, number> = { 2: 0.30, 3: 0.62, 4: 0.30 };
/**
 * How tall a head is relative to its width. `FaceBox.h` is a height, measured
 * from the ear-to-ear spread times this — see `headFromPose` — so this is what
 * turns it back into a width when the neighbour cap below needs one.
 */
const HEAD_ASPECT = 1.4;
/**
 * The narrowest a crop may be, in face widths.
 *
 * The neighbour cap can ask for a window narrower than the face it is supposed
 * to contain — two people sitting shoulder to shoulder in a close two-shot will
 * do it — and a crop that cuts through both cheeks is worse than a little of
 * the person beside them. 1.6 leaves a third of a face width of air on each
 * side.
 */
const MULTI_UP_MIN_CROP_FACE_WIDTHS = 1.6;
/**
 * How far a speaker's crop may be upscaled into its slot.
 *
 * This is the floor that stops a bad measurement zooming to a nostril, and it
 * is expressed as an upscale factor rather than as a fraction of source height
 * because softness is what the floor is actually protecting against, and
 * softness is a function of how many source pixels reach the output — not of
 * how much of the source the crop happened to cover.
 *
 * The old flat 0.5-of-source-height floor got this wrong in both directions.
 * On podcast-full.mp4, where a head in the wide two-shot is 0.115 of frame
 * height, the framing wanted a 0.38 box and the floor forced 0.50 — the
 * speakers ended up small and adrift in their halves for no gain, because 0.38
 * of a 1080p source is a 2.3x upscale that lanczos handles fine. On a 4K source
 * the same floor is 2x looser still, holding a crop that could have been sharp
 * AND tight. 2.5 gives podcast framing what it wants at 1080p and gets out of
 * the way entirely above it.
 */
const MULTI_UP_MAX_UPSCALE = 2.5;
/**
 * Where a face sits inside its slot, 0 (top edge) to 1 (bottom edge). Above
 * centre on purpose: it leaves headroom, and it keeps the seams — where the
 * captions land — on chest rather than on chin.
 */
const MULTI_UP_FACE_IN_BOX = 0.40;
/**
 * The same, for a crop shorter than the head it contains.
 *
 * A 1x3 band on a tightly-packed panel layout cannot be widened (the next
 * speaker's face is in the way) and so cannot be made tall enough to hold a
 * whole head — measured on the NFL three-panel master, a 428px-wide band is
 * 254px tall against a 369px head. There is no framing to choose there, only a
 * slice to aim, and the two things that must survive the cut are the eyes and
 * the mouth.
 *
 * `FaceBox.cy` is the centroid of the facial keypoints, which sits around the
 * eye line rather than the middle of the head, so the normal 0.40 spends its
 * budget above the eyes and clips the chin. 0.32 moves the window down by 8% of
 * its height: on those measurements it keeps the chin with ~25px to spare and
 * takes the loss out of the forehead instead, which is what a tight portrait
 * crop should do.
 */
const MULTI_UP_FACE_IN_BOX_TIGHT = 0.32;
/**
 * Minimum distance between two adjacent finished crop windows, as a fraction of
 * source width. Every window is clamped inside the source, so on a narrow
 * source they can collapse onto nearly the same x and the "stack" becomes the
 * same picture twice.
 *
 * Divided by the slot count, because four windows have to fit across the same
 * source width as two and holding four of them 10% of the width apart would
 * reject panels that are perfectly legible. What matters is whether the crops
 * are telling you about different people, and at four across a 1920px source
 * the resulting 5% is still 96px of parallax between neighbours. The numerator
 * is 0.20 so that the two-speaker case comes out at the 0.10 it has always used.
 */
const MULTI_UP_MIN_WINDOW_GAP_NUM = 0.20;
/**
 * How far apart a column's speakers may sit across the column, as a fraction of
 * the crop width, and still be squared up onto one shared x.
 *
 * A quarter of a crop is the point past which snapping would move a face far
 * enough inside its window to be visible as a mistake. Below it the move is
 * smaller than the headroom the framing already leaves. See the use site.
 */
const MULTI_UP_CROSS_ALIGN_FRAC = 0.25;

// ─── Finding the speakers: why this does NOT use BlazeFace ───────────────────
//
// The first version of the stack asked BlazeFace how many faces were on screen.
// It never fired, because BlazeFace essentially never reports two. Measured on
// three real podcast two-shots (Pexels 37874130 / 38655900 / 7586489), 80
// sampled frames each, counting frames containing TWO detections:
//
//                                 >=1 face   >=2 faces
//   blazeface @172x96 (shipping)   0/0/96%    0/0/0%
//   blazeface @896x504, score 0.5  0/14/95%   0/0/4%
//   movenet   @448x252             100% all   9/100/38%
//   movenet   @640x360             100% all   78/100/40%
//
// Two things there. BlazeFace is a FRONTAL, selfie-range detector, and podcast
// subjects sit in profile facing each other — on two of the three clips it
// found no face at all, at any resolution or score threshold, so raising the
// gates' generosity could never have helped. And detection RESOLUTION dominates
// everything else: MoveNet goes 9% -> 78% on the wide clip between 448 and 640
// wide, while the score thresholds barely register.
//
// MoveNet MULTIPOSE is a person detector, so it is orientation-invariant — a
// head turned fully away is still a pose — and it reports up to six people at
// once. Head position comes from whichever facial keypoints exist, falling back
// to the shoulders.
//
// The cost is real: 96ms/frame against BlazeFace's 18.5ms. It is affordable
// because the two-up QUESTION is static — a locked-off camera, two people who
// stay where they are — so it does not need the 4fps the single-speaker camera
// path needs. A couple of dozen frames spread across the clip answer it just as
// well: at 1fps the three clips scored 75/100/35% against 78/100/40% at 4fps.
//
/** Detection frame width for the speaker probe. Below ~640 the wide-shot recall collapses. */
const PROBE_W = 640;
/**
 * How densely to sample, in frames per second of clip.
 *
 * This used to be a flat 24 frames "regardless of clip length", on the argument
 * that a locked-off camera makes two-up a sampling question rather than a
 * tracking one. That argument holds only for a source that never cuts. Real
 * podcast masters cut constantly: podcast-full.mp4 is single close-ups for
 * 98 of its 106 seconds and a wide two-shot for the ~8 seconds around 1:03,
 * and 24 samples over the whole file put exactly 2 frames inside that two-shot.
 * You cannot locate a shot you sampled twice.
 *
 * At 1fps a shot boundary lands within half a second, which is finer than
 * TWO_UP_MIN_RUN_S needs. Measured cost on a 60s clip: 10.6s at 1fps against
 * 6.7s for the old 24 samples — 4 seconds, and only on clips that are not a
 * whole-clip two-shot, since those still skip the 4fps BlazeFace pass entirely.
 */
const PROBE_FPS = 1;
/** Floor for very short clips, so a 5s clip still gets a usable sample count. */
const PROBE_SAMPLES_MIN = 24;
/** Ceiling, so a 10-minute source cannot spend minutes in MoveNet. */
const PROBE_SAMPLES_MAX = 180;
/** Confidence floor for a whole pose, and for the individual keypoints. */
const PROBE_MIN_POSE_SCORE = 0.2;
const PROBE_MIN_KEYPOINT_SCORE = 0.3;
/** Keypoints that locate a head, best first. */
const HEAD_KEYPOINTS = ["nose", "left_eye", "right_eye", "left_ear", "right_ear"];

// ─── CAMERA MOTION ───────────────────────────────────────────────────────────
//
// main-code.js runs detection at the source frame rate, so it can count frames:
// INTRA_SPEAKER_SMOOTH=0.96, SNAP_CONFIRM_FRAMES=8, ABSENT=30 all mean "n frames
// at ~30fps". Here detection runs at DETECTION_FPS=4 — 7.5x coarser — so the same
// numbers meant 7.5x longer in wall-clock time: a 0.8s glide became a 6s crawl and
// a 0.27s speaker switch became a 2s lag. Time constants, not frame counts.
//
/** How long the pan takes to cover ~63% of the distance to a moved face. */
const INTRA_SPEAKER_TAU_S = 0.82;
/** How long a second face must hold the frame before the camera cuts to it. */
const SWITCH_CONFIRM_S    = 0.30;
/** How long with no face at all before the camera forgets who it was following. */
const ABSENT_RESET_S      = 1.00;
/**
 * How far the face may wander, as a fraction of source width, before the camera
 * starts following it.
 *
 * main-code.js has no deadzone and does not need one: at 30fps its EMA averages
 * 30 detections a second, so BlazeFace's per-frame jitter is smoothed into
 * nothing. At 4fps the same time constant sees 7.5x fewer samples and passes
 * ~2.7x more of that jitter through (EMA noise gain is sqrt((1-a)/(1+a))), which
 * shows up as a camera that fidgets around a speaker who is sitting still.
 *
 * A deadzone fixes that at the source instead of by over-damping: locked while
 * the face stays inside it, fully responsive once the face leaves. 1.5% of a
 * 1920px source is ~29px, comfortably more than the post-median jitter.
 */
const CAMERA_DEADZONE_REL = 0.015;
/**
 * Fraction of the deadzone the error must fall back inside before the camera
 * locks again — hysteresis, so the pan finishes CENTRED rather than stopping the
 * instant it re-enters the deadzone. Without it the camera parks wherever it
 * crossed the boundary and every move leaves the face up to a full deadzone
 * off-centre (measured: 21px RMS vs 7px for the old over-damped path).
 */
const CAMERA_RELOCK_FRACTION = 0.25;
/**
 * Median filter width, in samples, over the raw detections. One bad BlazeFace box
 * (a hand, a bystander, half a face at the frame edge) is a single-sample spike;
 * a median removes it outright where an average would smear it into the path.
 *
 * 5 over 3, measured on synthetic single-speaker signals with 3% bad boxes and 6%
 * dropped frames (per-frame cropX read back off the crop filter, 3 seeds):
 *
 *                      window=3            window=5
 *   still speaker   moves on 0-9%       moves on 0-4%   ← fully locked on 2/3 seeds
 *   drifting        max step 3.6-10.7   max step 3.6-7.1
 *   fast lean       off-centre 29-38px  off-centre 29-38px  ← no cost
 *
 * The wider window costs up to 2 samples (500ms) of delay on genuinely fast
 * motion, which the "fast lean" case is there to catch — and it doesn't show.
 */
const MEDIAN_WINDOW = 5;
/**
 * Straightness tolerance, in source pixels, when collapsing the per-sample crop
 * path into straight pans. crop() floors x to an even number for 4:2:0 chroma
 * anyway, so anything under ~1px is invisible and only lengthens the ffmpeg
 * expression.
 */
const PATH_SIMPLIFY_TOL_PX = 1.0;

/** Per-detection-sample EMA weight for a time constant in seconds. */
function emaWeight(tauSeconds: number, sampleFps: number): number {
  return Math.exp(-1 / (sampleFps * tauSeconds));
}

/** Seconds → detection samples, floored at 2 so one noisy sample can't decide. */
function samples(seconds: number, sampleFps: number): number {
  return Math.max(2, Math.round(seconds * sampleFps));
}

/**
 * Median-filter the raw detections, preserving nulls.
 *
 * Nulls are load-bearing — ABSENT_RESET_S counts them to decide the camera has
 * lost its subject — so a null sample stays null rather than being filled in by
 * its neighbours. Windows that straddle a null just use the values they have.
 */
function medianFilter(rawCx: (number | null)[], window: number): (number | null)[] {
  if (window < 3) return rawCx;
  const half = Math.floor(window / 2);
  return rawCx.map((v, i) => {
    if (v === null) return null;
    const vals: number[] = [];
    for (let j = i - half; j <= i + half; j++) {
      const x = rawCx[j];
      if (j >= 0 && j < rawCx.length && x !== null) vals.push(x);
    }
    // Two values have no median — picking either one is just a biased guess, and
    // taking the lower one silently pulled the camera left near dropped frames.
    // Pass the sample through instead and let the deadzone absorb it.
    if (vals.length < 3) return v;
    vals.sort((a, b) => a - b);
    return vals[vals.length >> 1];
  });
}

// ─── Module-level caches ─────────────────────────────────────────────────────
let _blazeFaceModel: any = null;

/**
 * Load BlazeFace once per process, retrying the load itself.
 *
 * `blazeface.load()` FETCHES the model weights over the network on first use, so
 * a cold process whose first request lands during a blip fails detection for
 * that clip and every clip after it in the same batch — which is exactly the
 * shape of the observed failures: the first clip of a project errors out and
 * clips 2..N succeed, because the second clip's load happened to work.
 *
 * Retried here rather than at the call site so one flaky fetch cannot cost a
 * clip a whole detection attempt (each of which re-pipes frames through ffmpeg).
 */
async function loadBlazeFace(): Promise<void> {
  if (_blazeFaceModel) {
    console.log("[facetrack] Model ready (cached).");
    return;
  }
  const { withRetry } = await import("./retry.ts");
  _blazeFaceModel = await withRetry(
    async () => {
      console.log("[facetrack] Loading BlazeFace…");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const tfCore = require("@tensorflow/tfjs") as typeof import("@tensorflow/tfjs");
      if (!tfCore.getBackend()) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("@tensorflow/tfjs-node");
      }
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const blazeface = require("@tensorflow-models/blazeface") as typeof import("@tensorflow-models/blazeface");
      return blazeface.load({ scoreThreshold: MIN_SCORE });
    },
    { attempts: 4, baseDelayMs: 2_000, label: "facetrack blazeface-load" }
  );
  console.log("[facetrack] Model ready.");
}

// Encode args — libx264 crf 20, preset veryfast, CFR at the source fps.
// veryfast encodes ~2.5× faster than `fast` (35s clip: 14.5s vs 36.9s here)
// at crf 20 with negligible visual difference — the dominant cost of a batch,
// so this is the biggest speedup lever. (No videotoolbox, so mac and Linux
// output stay identical.)
function codecArgs(fps: number): string[] {
  return ["-c:v", "libx264", "-crf", "20", "-preset", "veryfast",
          "-vsync", "cfr", "-r", String(fps), "-movflags", "+faststart"];
}

/**
 * Resident memory one encode may reach before it is stopped.
 *
 * Measured 2026-09-15 by replaying that day's real clips through the exact
 * argv `encodeWithCropData` builds, in the production image, with the binary
 * the app spawns (ffmpeg-static 7.0.2), under the app's 2 GiB cap: 387–550 MB
 * across 1080p60 H.264 and 1432p VP9 sources, 2- and 3-speaker stacks, and
 * starved to one core. The same day the kernel killed one encode seven times
 * at ~1.6 GB. 1 GB is ~2x the worst real peak, and with one encode at a time
 * (FACETRACK_BOX_LIMIT) it keeps encode + web server (~500 MB) + worker under
 * the container limit, so a runaway costs one clip its tracked framing instead
 * of costing every in-flight run a 502.
 */
const ENCODE_RSS_BUDGET_BYTES = 1024 * 1024 * 1024;

// ─── Async ffmpeg helper ──────────────────────────────────────────────────────
function spawnFfmpegAsync(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: "inherit" });
    // An encode is the largest thing in this container. If memory runs out it
    // should be the one to go, not the web server — see lib/oomVictim.ts.
    preferOomKill(proc);
    const guard = watchRss(proc, ENCODE_RSS_BUDGET_BYTES, (rss) => {
      // The full command, because it is the evidence: nothing else records
      // which input and which graph made an encode run away.
      console.error(
        `[facetrack] ffmpeg passed ${Math.round(rss / 1048576)} MB — stopping it. argv: ` +
        JSON.stringify(args)
      );
    });
    proc.on("close", (code, signal) => {
      guard.stop();
      const peak = guard.exceeded();
      if (peak !== null) reject(new MemoryBudgetError("ffmpeg encode", peak, ENCODE_RSS_BUDGET_BYTES));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg ${describeExit(code, signal)}`));
    });
    proc.on("error", reject);
  });
}

// ─── Detection result ─────────────────────────────────────────────────────────
export interface CropResult {
  srcW: number;
  srcH: number;
  fps: number;
  hasAudio: boolean;
  clipStart: number;
  clipEnd: number;
  cropW: number;
  cropH: number;
  rawCropW: number;
  isBlurBg: boolean;
  cropXExpr?: string;      // tracking mode
  filterComplex?: string;  // blur-bg mode
  /**
   * True when this plan came from `staticCropData` — a fixed centre crop built
   * without running detection at all. Callers persist a "not tracked" clip the
   * same way as a tracked one; the flag exists so logs and `faceFocusY` do not
   * claim a measurement that never happened.
   */
  isStatic?: boolean;
  /**
   * Where the speaker's face sits vertically, 0 (top) to 1 (bottom), as the
   * median over every frame a face was found. Undefined when no face was.
   *
   * The crop is horizontal-only — cropH is always the full source height — so
   * this fraction is identical in the source and in the 9:16 output, and the
   * compositions can use it directly to decide which slice of the clip to show
   * when a split-screen B-roll cutaway leaves the speaker half a frame.
   */
  faceFocusY?: number;
  /**
   * "split" when the encoded clip contains a stack of several speakers rather
   * than only a tracked face. Auto B-roll reads it to leave the clip alone,
   * since a split cutaway would squeeze the stack into slivers.
   */
  speakerLayout?: "single" | "split";
  /**
   * How many people that stack holds — 2, 3 or 4. Undefined on a "single" clip.
   *
   * The composition needs it to know where the seam is: 2 and 4 put a
   * horizontal seam across the middle of the frame, 3 puts them at a third and
   * two thirds, and the captions go on a band that covers no face.
   */
  speakerSlots?: number;
  /**
   * When the stack is on screen, in seconds from the start of the clip.
   *
   * The composition reads this to put the captions on the seam for exactly the
   * frames that are stacked. Empty when `speakerLayout` is "single"; a single
   * range covering the clip when the whole clip is a stack.
   */
  stackedRanges?: TimeRange[];
  /**
   * Why no stack was even CONSIDERED — set only when the speaker probe could
   * not run in this environment, never when it ran and found nothing.
   *
   * Carried out to the caller so the failure shows up where somebody is
   * looking. A stack that silently stops happening looks exactly like a clip
   * that never had two speakers in it, which is how this went unnoticed for
   * three days; see POSE_DETECTOR_PACKAGES.
   */
  multiUpError?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ffmpegBin(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const b = require("ffmpeg-static") as string | { default: string };
    const p = typeof b === "string" ? b : b?.default;
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return "ffmpeg";
}

interface VideoInfo {
  width: number;
  height: number;
  fps: number;
  duration: number;
  hasAudio: boolean;
}

function probeVideo(file: string): VideoInfo {
  const raw = execSync(
    `ffprobe -v quiet -print_format json -show_streams "${file}"`,
    { encoding: "utf8" }
  );
  const streams = (JSON.parse(raw) as { streams: any[] }).streams;
  const v = streams.find((s) => s.codec_type === "video");
  if (!v) throw new Error("No video stream: " + file);

  function parseRate(str: string | undefined): number | null {
    if (!str) return null;
    const [n, d] = str.split("/").map(Number);
    if (!d || d === 0) return null;
    return n / d;
  }

  const fps =
    parseRate(v.r_frame_rate) ??
    parseRate(v.avg_frame_rate) ??
    (() => { throw new Error("Cannot determine FPS: " + file); })();

  return {
    width:    parseInt(v.width),
    height:   parseInt(v.height),
    fps,
    duration: parseFloat(v.duration ?? v.tags?.DURATION ?? "0"),
    hasAudio: streams.some((s) => s.codec_type === "audio"),
  };
}

function pipeFrames(
  ffmpeg: string,
  input: string,
  clipStart: number,
  clipDur: number,
  detectW: number,
  detectH: number,
  detectionFps: number
): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const frameSize = detectW * detectH * 3;
    const frames: Uint8Array[] = [];
    let buf = Buffer.alloc(0);

    const args: string[] = ["-ss", String(clipStart), "-i", input];
    if (isFinite(clipDur)) args.push("-t", String(clipDur));
    args.push(
      "-vf",      `scale=${detectW}:${detectH},fps=${detectionFps}`,
      "-f",       "rawvideo",
      "-pix_fmt", "rgb24",
      "pipe:1"
    );

    const proc = spawn(ffmpeg, args);
    preferOomKill(proc);

    proc.stdout.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= frameSize) {
        const frame = new Uint8Array(frameSize);
        buf.copy(Buffer.from(frame.buffer), 0, 0, frameSize);
        frames.push(frame);
        buf = buf.slice(frameSize);
      }
    });

    proc.stderr.on("data", () => {});
    proc.on("error", reject);
    proc.on("close", (code, signal) => {
      // `code` is null when a signal ended the process. That used to fall
      // through to resolve(), so an ffmpeg the OOM killer stopped halfway
      // handed back half a clip's frames as if detection had seen all of them.
      if (code !== 0) {
        reject(new Error(`ffmpeg pipe ${describeExit(code, signal)}`));
      } else {
        resolve(frames);
      }
    });
  });
}

/**
 * Per-sample crop centre, plus which samples are hard cuts to a new speaker.
 * `cuts[i] === true` means the camera JUMPS at sample i and must not be
 * interpolated into — see buildCropPath.
 */
interface CenterPath {
  centers: number[];
  cuts: boolean[];
}

function buildCommittedCenters(rawInput: (number | null)[], sampleFps: number): CenterPath {
  const rawCx = medianFilter(rawInput, MEDIAN_WINDOW);
  const N = rawCx.length;
  const switchEvents: { candidateStart: number; confirmedAt: number; cx: number }[] = [];

  const confirmSamples = samples(SWITCH_CONFIRM_S, sampleFps);
  const absentSamples  = samples(ABSENT_RESET_S, sampleFps);
  const smoothAlpha    = emaWeight(INTRA_SPEAKER_TAU_S, sampleFps);

  let committed: number | null = null;
  let candCx: number | null = null;
  let candStart: number | null = null;
  let candCount = 0;
  let absentCount = 0;

  for (let i = 0; i < N; i++) {
    const cx = rawCx[i];

    if (cx === null) {
      absentCount++;
      if (absentCount >= absentSamples) {
        committed = null;
        candCx    = null;
        candStart = null;
        candCount = 0;
      }
      continue;
    }

    absentCount = 0;

    if (committed === null) {
      committed = cx;
      candCx    = null;
      candStart = null;
      candCount = 0;
      switchEvents.push({ candidateStart: i, confirmedAt: i, cx: committed });
      continue;
    }

    const delta = Math.abs(cx - committed);

    if (delta <= SWITCH_THRESHOLD) {
      candCx    = null;
      candStart = null;
      candCount = 0;
    } else {
      if (candCx !== null && Math.abs(cx - candCx) <= SWITCH_THRESHOLD) {
        candCount++;
      } else {
        candCx    = cx;
        candStart = i;
        candCount = 1;
      }

      if (candCount >= confirmSamples) {
        committed = candCx!;
        switchEvents.push({
          candidateStart: candStart!,
          confirmedAt:    i,
          cx:             committed,
        });
        candCx    = null;
        candStart = null;
        candCount = 0;
      }
    }
  }

  console.log(
    `[facetrack] buildCommittedCenters: ${switchEvents.length} switch event(s)` +
    ` (@${sampleFps}fps: confirm=${confirmSamples} absent=${absentSamples}` +
    ` alpha=${smoothAlpha.toFixed(3)}):`
  );
  for (const e of switchEvents) {
    console.log(
      `[facetrack]   switch: candidateStart=${e.candidateStart} confirmedAt=${e.confirmedAt}` +
      ` cx=${e.cx.toFixed(3)} back-dated to frame ${e.candidateStart}`
    );
  }

  const transitions = switchEvents
    .map((e) => ({ frame: e.candidateStart, cx: e.cx }))
    .sort((a, b) => a.frame - b.frame);

  const out  = new Array<number>(N).fill(TRUE_CENTER_REL);
  const cuts = new Array<boolean>(N).fill(false);
  if (transitions.length === 0) return { centers: out, cuts };

  let tIdx       = 0;
  let activeCx   = TRUE_CENTER_REL;
  let smoothedCx: number | null = null;
  /** True while the camera is actively panning toward the face (see deadzone). */
  let tracking   = false;

  for (let i = 0; i < N; i++) {
    while (tIdx < transitions.length && transitions[tIdx].frame <= i) {
      activeCx   = transitions[tIdx].cx;
      smoothedCx = activeCx;
      // A cut lands dead-centre on the new speaker, so the camera starts locked.
      tracking = false;
      // A switch is a CUT, not a pan: the whole point of back-dating it is that
      // the frame changes the instant the new speaker appears. Flag it so the
      // interpolator holds the old centre right up to this sample and jumps
      // here, instead of sliding across the gap between two faces.
      if (tIdx > 0) cuts[i] = true;
      tIdx++;
    }

    if (rawCx[i] !== null && smoothedCx !== null) {
      const target = rawCx[i]!;
      // Only track the speaker we are already on; a face further away than
      // SWITCH_THRESHOLD is the other person, and that is a cut, not a pan.
      if (Math.abs(target - activeCx) <= SWITCH_THRESHOLD) {
        // Deadzone with hysteresis. Locked until the face strays further than
        // CAMERA_DEADZONE_REL, then the plain EMA glides all the way back to
        // centre and re-locks. The two thresholds are what stop it from
        // oscillating on and off around a single boundary.
        const err = target - smoothedCx;
        if (Math.abs(err) > CAMERA_DEADZONE_REL) tracking = true;
        if (tracking) {
          smoothedCx += (1 - smoothAlpha) * err;
          if (Math.abs(err) < CAMERA_DEADZONE_REL * CAMERA_RELOCK_FRACTION) tracking = false;
        }
      }
    }

    out[i] = smoothedCx ?? activeCx;
  }

  const firstKnown = transitions[0]?.cx ?? TRUE_CENTER_REL;
  for (let i = 0; i < N; i++) {
    if (out[i] === TRUE_CENTER_REL && (transitions[0]?.frame ?? 0) > i) {
      out[i] = firstKnown;
    }
    out[i] = Math.max(0, Math.min(1, out[i]));
  }

  return { centers: out, cuts };
}

/** Left edge of the crop window, in source pixels, for a relative centre. */
function toCropX(rel: number, srcW: number, cropW: number): number {
  return Math.max(0, Math.min(srcW - cropW, rel * srcW - cropW / 2));
}

/**
 * One straight move of the camera: cropX goes from x0 at startFrame to x1 at
 * endFrame, linearly. x0 === x1 means the camera is parked.
 *
 * These are ENCODE frames, not detection samples — a segment normally spans many
 * frames and the expression interpolates within it, which is what makes the pan
 * continuous instead of a staircase.
 */
interface CropSegment {
  startFrame: number;
  endFrame: number;
  x0: number;
  x1: number;
}

/**
 * Turn per-sample crop centres into a piecewise-linear camera path over encode
 * frames.
 *
 * The problem this solves: detection samples at 4fps but the video plays at
 * 25-30fps. Holding each sample's cropX for the whole ~7-frame gap (what
 * building runs at detection resolution did) means the camera only ever moves 4
 * times a second — small, regular jerks that read as a stutter even though the
 * underlying centres are smooth. Interpolating between samples spreads each move
 * across every frame in the gap.
 *
 * Two things are deliberately NOT smoothed:
 *   - Cuts. A confirmed speaker switch jumps; sliding the frame between two
 *     faces would show the wall between them.
 *   - The tail. After the last sample the camera parks, it does not extrapolate.
 *
 * Collinear samples are then collapsed with a greedy Douglas-Peucker pass, so a
 * slow steady pan across 40 samples becomes one segment rather than 40. That
 * keeps the ffmpeg expression small without changing the path by more than
 * PATH_SIMPLIFY_TOL_PX.
 */
function buildCropPath(
  path: CenterPath,
  srcW: number,
  cropW: number,
  framesPerSample: number
): CropSegment[] {
  const { centers, cuts } = path;
  const N = centers.length;
  if (N === 0) return [];

  const xs = centers.map((c) => toCropX(c, srcW, cropW));
  const ns = centers.map((_, k) => Math.round(k * framesPerSample));

  if (N === 1) {
    return [{ startFrame: 0, endFrame: Number.MAX_SAFE_INTEGER, x0: xs[0], x1: xs[0] }];
  }

  const segments: CropSegment[] = [];
  const push = (from: number, to: number, x1: number) => {
    if (ns[to] <= ns[from]) return; // zero-length after rounding — nothing to draw
    segments.push({ startFrame: ns[from], endFrame: ns[to], x0: xs[from], x1 });
  };

  /** Max deviation from the straight line through samples a..b, in pixels. */
  const deviation = (a: number, b: number): number => {
    const span = ns[b] - ns[a];
    if (span <= 0) return Infinity;
    const slope = (xs[b] - xs[a]) / span;
    let worst = 0;
    for (let m = a + 1; m < b; m++) {
      worst = Math.max(worst, Math.abs(xs[m] - (xs[a] + slope * (ns[m] - ns[a]))));
    }
    return worst;
  };

  let anchor = 0;
  for (let k = 1; k < N; k++) {
    if (cuts[k]) {
      // Finish whatever pan was in progress at the previous sample, then park on
      // the old speaker until the exact frame of the cut. Closing the pan first
      // matters when the camera was still moving when the other speaker started:
      // holding from `anchor` instead would throw that motion away.
      if (k - 1 > anchor) push(anchor, k - 1, xs[k - 1]);
      push(k - 1, k, xs[k - 1]);
      anchor = k;
      continue;
    }
    // Extend the current straight move as long as it stays within tolerance and
    // the next sample is not a cut.
    const nextIsCut = k + 1 < N && cuts[k + 1];
    if (nextIsCut || k === N - 1 || deviation(anchor, k + 1) > PATH_SIMPLIFY_TOL_PX) {
      push(anchor, k, xs[k]);
      anchor = k;
    }
  }

  // Park at the last known centre for the rest of the clip. The detection window
  // ends at clipEnd but the encoder may emit a frame or two past the last sample.
  segments.push({
    startFrame: ns[N - 1],
    endFrame: Number.MAX_SAFE_INTEGER,
    x0: xs[N - 1],
    x1: xs[N - 1],
  });

  return segments;
}

/** ffmpeg sub-expression for one segment: a constant, or a linear ramp in `n`. */
function segmentExpr(seg: CropSegment): string {
  const x0 = Math.round(seg.x0);
  const x1 = Math.round(seg.x1);
  if (x0 === x1) return String(x0);
  const span = seg.endFrame - seg.startFrame;
  // No commas here on purpose — only the ones inside lt() need escaping below.
  return `(${x0}+${x1 - x0}*(n-${seg.startFrame})/${span})`;
}

/**
 * Balanced binary search over segment start frames, so per-frame evaluation
 * costs log2(segments) comparisons rather than a linear scan.
 */
function buildCropXExpr(segments: CropSegment[]): string {
  if (segments.length === 0) return "0";

  function makeExpr(lo: number, hi: number): string {
    if (lo === hi) return segmentExpr(segments[lo]);
    const mid       = (lo + hi) >> 1;
    const threshold = segments[mid + 1].startFrame;
    return `if(lt(n\\,${threshold}),${makeExpr(lo, mid)},${makeExpr(mid + 1, hi)})`;
  }

  return makeExpr(0, segments.length - 1);
}

// ─── The speaker probe (MoveNet MultiPose) ───────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
let _poseDetector: Promise<any> | null = null;

/**
 * Packages `loadPoseDetector` needs at require time, beyond the one it names.
 *
 * `@tensorflow-models/pose-detection`'s entry point pulls in EVERY detector it
 * ships, including the MediaPipe BlazePose one, whose module does a top-level
 * `require("@mediapipe/pose")`. We never create that detector — we only ever
 * ask for MoveNet — but the require happens anyway, so the package has to be
 * installed or the whole module throws MODULE_NOT_FOUND.
 *
 * It is a PEER dependency of pose-detection, which is why this is a trap: pnpm
 * installs peers automatically (auto-install-peers, on by default since pnpm 8)
 * and npm does not — and the render server's image builds with
 * `npm install --legacy-peer-deps`, which skips peers outright. So the app box
 * had it, the render box did not, and moving face tracking to the render box on
 * 2026-09-19 silently turned off every multi-speaker stack: 912 clips over three
 * days came out as single-speaker crops, with nothing but a `console.warn` on a
 * container nobody was reading to say so.
 *
 * Exported because `scripts/sync-facetrack.mjs --check` audits the render repo's
 * package.json against it, so the next such peer cannot ship missing.
 */
export const POSE_DETECTOR_PACKAGES = [
  "@tensorflow/tfjs",
  "@tensorflow/tfjs-node",
  "@tensorflow-models/pose-detection",
  "@mediapipe/pose",
] as const;

/**
 * Did the probe fail because it CANNOT RUN HERE, rather than because this clip
 * defeated it?
 *
 * The two want opposite responses and used to get the same one. A clip the
 * probe merely found nothing in is an ordinary single-speaker clip and the warn
 * is right. A probe that cannot load its model is an environment fault that
 * will hit EVERY clip this box ever sees, and it has to be impossible to miss —
 * see POSE_DETECTOR_PACKAGES for what it cost the first time.
 */
function isProbeUnavailable(err: unknown): boolean {
  const code = (err as { code?: string } | null | undefined)?.code;
  if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /Cannot find module|Cannot find package|is not a function/i.test(msg);
}

/**
 * Can the speaker probe run at all in this process?
 *
 * Answers the one question `/health` could not: BlazeFace loading tells you
 * nothing about MoveNet, and a box where only MoveNet is broken produces
 * perfectly good-looking single-speaker clips forever. Callers surface the
 * message; they do not have to understand it.
 */
export async function poseDetectorHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    await loadPoseDetector();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.split("\n")[0] : String(err) };
  }
}

/** Loaded once per process, like the BlazeFace model below it. */
function loadPoseDetector(): Promise<any> {
  _poseDetector ??= (async () => {
    console.log("[facetrack] Loading MoveNet MultiPose…");
    // Required, not imported, for the same reason as BlazeFace below: these
    // pull a native addon and tens of megabytes of weights, and a top-level
    // import would load them into every process that touches this module.
    // (`no-var-requires` is the directive the rest of this file uses; the rule
    // was renamed, so those lines now report as errors AND unused directives.)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("@tensorflow/tfjs-node");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const poseDetection = require("@tensorflow-models/pose-detection");
    const det = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
      modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
      enableTracking: false,
    });
    console.log("[facetrack] MoveNet ready.");
    return det;
  })().catch((err) => {
    _poseDetector = null; // a failed fetch must not be cached forever
    throw err;
  });
  return _poseDetector;
}

/** One pose reduced to a head box, or null when nothing locates the head. */
function headFromPose(pose: any, frameH: number): FaceBox | null {
  const kps: any[] = pose?.keypoints ?? [];
  const named = (n: string) => kps.find((k) => k.name === n);

  const facial = kps.filter(
    (k) => HEAD_KEYPOINTS.includes(k.name) && (k.score ?? 0) >= PROBE_MIN_KEYPOINT_SCORE
  );
  if (facial.length > 0) {
    const cx = facial.reduce((a, k) => a + k.x, 0) / facial.length;
    const cy = facial.reduce((a, k) => a + k.y, 0) / facial.length;
    // Ear-to-ear (or eye-to-eye) spread is a head WIDTH; a head is roughly 1.4x
    // taller than wide. With one keypoint there is no spread to measure, so fall
    // through to the shoulder estimate for size only.
    const spread = facial.length > 1
      ? Math.max(...facial.map((k) => k.x)) - Math.min(...facial.map((k) => k.x))
      : 0;
    const shoulders = [named("left_shoulder"), named("right_shoulder")].filter(
      (k) => k && (k.score ?? 0) >= PROBE_MIN_KEYPOINT_SCORE
    );
    const shoulderW = shoulders.length === 2
      ? Math.abs((shoulders[0] as any).x - (shoulders[1] as any).x)
      : 0;
    const headH = Math.max(spread * 1.4, shoulderW * 0.55);
    if (!(headH > 0)) return null;
    return { cx, cy, h: headH / frameH };
  }

  // Face fully turned away or occluded — the shoulders still say where the head
  // is. This is the case BlazeFace has no answer for at all.
  const l = named("left_shoulder");
  const r = named("right_shoulder");
  if (l && r && (l.score ?? 0) >= PROBE_MIN_KEYPOINT_SCORE && (r.score ?? 0) >= PROBE_MIN_KEYPOINT_SCORE) {
    const w = Math.abs(l.x - r.x);
    if (!(w > 0)) return null;
    return { cx: (l.x + r.x) / 2, cy: (l.y + r.y) / 2 - w * 0.75, h: (w * 0.55) / frameH };
  }
  return null;
}

// ─── Sliced detection: finding people the whole-frame pass is too coarse for ──
//
// MoveNet resizes whatever you hand it down to its own input size, so feeding
// it a bigger frame buys much less than it looks like it should. Measured on
// the WATP source (1920x1080, three hosts in a right-hand rail beside a
// screen share, 28 samples over a 27.6s clip), counting heads found per frame:
//
//                          0 heads  1     2     3     4     5
//   whole frame @640         22     5     1     -     -     -
//   whole frame @960         24     4     -     -     -     -
//   whole frame @1280        12    14     2     -     -     -
//   whole frame @1600        12    13     3     -     -     -
//   2 slices    @640          -     -     1    13    12     2
//   2 slices    @1280         -     -     2    12    13     1
//
// Four times the pixels moves the whole-frame pass from "never sees two of the
// three" to "never sees two of the three". Cutting the frame in half and
// detecting on each half finds all three on most frames — at the ORIGINAL 640,
// because what the detector needs is the subject to be a bigger fraction of its
// input, and a slice gives it that for free. BlazeFace was measured on the same
// clip for completeness and is worse still (1 face at best, at every width and
// both score thresholds), for the reason the block above PROBE_W already gives.
//
// Slices are horizontal only — full-height columns. Two reasons: the layouts
// this rescues put their speakers in a vertical rail, which a vertical cut
// would saw in half; and a full-height slice leaves `FaceBox.h` — a fraction of
// FRAME height — correct with no rescaling.

/** How many slices the fallback pass cuts a frame into. */
const PROBE_SLICES = 4;
/**
 * How much of the frame each slice covers, as a fraction.
 *
 * Above 1/PROBE_SLICES so neighbouring slices overlap: a person straddling the
 * cut is otherwise split down the middle and found by neither pass. 0.6 for two
 * slices leaves a 20%-of-frame band that both slices see whole, which is wider
 * than any head at the framings this exists for.
 */
const PROBE_SLICE_COVER = 0.6;
/**
 * How close two head boxes must be, in fractions of the frame, to be one person
 * seen by both slices rather than two people.
 *
 * Only ever applied inside the overlap band, where the same head really can be
 * reported twice. 0.05 is the same order as MULTI_UP_SAME_SHOT_CX_FLOOR and an
 * order of magnitude below MULTI_UP_MIN_SEPARATION, so it cannot merge two
 * people the group test would have kept apart.
 */
const PROBE_DEDUPE_DIST = 0.05;

/** Full-height detection windows covering the frame, left to right. */
function sliceWindows(w: number, slices: number): { x: number; w: number }[] {
  if (slices <= 1) return [{ x: 0, w }];
  const sw = Math.max(2, Math.round((w * PROBE_SLICE_COVER) / 2) * 2);
  const step = (w - sw) / (slices - 1);
  return Array.from({ length: slices }, (_, i) => ({ x: Math.round(i * step), w: sw }));
}

/** A full-height column of an rgb24 frame, copied out row by row. */
function cropRgb(src: Uint8Array, w: number, h: number, x: number, cw: number): Uint8Array {
  const out = new Uint8Array(cw * h * 3);
  for (let y = 0; y < h; y++) {
    const from = (y * w + x) * 3;
    out.set(src.subarray(from, from + cw * 3), y * cw * 3);
  }
  return out;
}

/** Heads from overlapping slices, with the double-counted ones merged. */
function dedupeHeads(heads: FaceBox[]): FaceBox[] {
  const out: FaceBox[] = [];
  for (const b of heads) {
    if (!out.some((u) => Math.hypot(u.cx - b.cx, u.cy - b.cy) < PROBE_DEDUPE_DIST)) out.push(b);
  }
  return out;
}

/**
 * Sample the clip and report every person's head position per frame.
 *
 * Sampled at PROBE_FPS, clamped to [PROBE_SAMPLES_MIN, PROBE_SAMPLES_MAX] total
 * frames, because the answer is no longer a single yes/no for the clip: the
 * stack now switches on and off with the source's own cuts, and a boundary can
 * only be placed as finely as it was sampled.
 *
 * Exported for the same reason as `planMultiUp` and `planCropXExpr`: every number
 * in the TWO_UP block above was measured by running this over real footage and
 * reading the head boxes, and a gate you cannot re-measure is a gate you cannot
 * re-tune.
 *
 * `slices` runs the detector on overlapping horizontal halves of each frame
 * instead of on the whole frame — see PROBE_SLICES and `sliceWindows`.
 */
export async function probeSpeakers(
  ffmpeg: string,
  inputPath: string,
  clipStart: number,
  clipDur: number,
  srcW: number,
  srcH: number,
  slices: number = 1
): Promise<{ perFrame: FaceBox[][]; probeFps: number }> {
  const w = Math.max(2, Math.round(PROBE_W / 2) * 2);
  const h = Math.max(2, Math.round((srcH / srcW) * w / 2) * 2);
  const dur = Math.max(1, clipDur);
  const probeFps = Math.min(
    Math.max(PROBE_FPS, PROBE_SAMPLES_MIN / dur),
    PROBE_SAMPLES_MAX / dur
  );

  const detector = await loadPoseDetector();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tf = require("@tensorflow/tfjs") as typeof import("@tensorflow/tfjs");

  const frames = await pipeFrames(ffmpeg, inputPath, clipStart, clipDur, w, h, probeFps);
  const windows = sliceWindows(w, slices);
  console.log(
    `[facetrack] Speaker probe: ${frames.length} frames at ${w}×${h} (${probeFps.toFixed(2)}fps)` +
    (windows.length > 1 ? `, ${windows.length} slices of ${windows[0].w}px.` : ".")
  );

  const perFrame: FaceBox[][] = [];
  for (const frame of frames) {
    const heads: FaceBox[] = [];
    for (const win of windows) {
      const pixels = win.w === w ? frame : cropRgb(frame, w, h, win.x, win.w);
      const tensor = tf.tensor3d(pixels, [h, win.w, 3], "int32");
      let poses: any[] = [];
      try {
        poses = await detector.estimatePoses(tensor, { maxPoses: 6 });
      } finally {
        (tf as any).dispose(tensor);
      }
      for (const p of poses) {
        if ((p.score ?? 0) < PROBE_MIN_POSE_SCORE) continue;
        // The slices are full-height by construction, so `h` — a fraction of
        // frame height — needs no correction; only cx is offset back into the
        // whole frame. planMultiUp works in fractions of the frame, not pixels.
        const b = headFromPose(p, h);
        if (!b) continue;
        heads.push({
          cx: Math.max(0, Math.min(1, (b.cx + win.x) / w)),
          cy: Math.max(0, Math.min(1, b.cy / h)),
          h: b.h,
        });
      }
    }
    perFrame.push(windows.length > 1 ? dedupeHeads(heads) : heads);
  }
  // The rate comes back with the frames because it is the only thing that turns
  // a frame index into a timestamp, and the ranges planMultiUp returns are
  // timestamps.
  return { perFrame, probeFps };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── Multi-up planning ───────────────────────────────────────────────────────

/** One head box, in fractions of the source frame. */
export interface FaceBox {
  cx: number;
  cy: number;
  /** Box height, as a fraction of frame height. Drives how far to zoom in. */
  h: number;
}

/**
 * One stack shape and the stretches of clip it is on screen for.
 *
 * A clip can hold more than one of these, because a podcast master cuts between
 * shots that hold different numbers of people: the source that prompted this
 * cuts between a two-shot of the guests and a wide that also holds the host.
 * Two people get a 50/50 split and three get three equal bands — that is the
 * rule, and it is a rule about the SHOT, not about the clip.
 */
export interface MultiUpLayout {
  /** How many people this stack holds — 2, 3 or 4. Drives the slot grid. */
  slots: number;
  /**
   * Crop size in source pixels — IDENTICAL for every speaker.
   *
   * Sizing each speaker's box from their own face would scale the heads
   * differently, which reads as a mistake even when it is a faithful record of
   * who is sitting closer to the camera. One box size, positioned N times.
   *
   * Per LAYOUT, not per clip: the wide three-shot and the tighter two-shot are
   * different framings of the same room, and sizing both from one measurement
   * would be the "mixing a wide shot's heads with a close-up's" mistake that
   * `inKept` exists to prevent, one level up.
   */
  boxW: number;
  boxH: number;
  /**
   * Which axis of the SOURCE the speakers were separated along — see StackAxis.
   * Reported for the logs and for anything that needs to reason about the crop
   * order; the filter graph does not need it, because `crops` are absolute.
   */
  axis: StackAxis;
  /**
   * Top-left corner of each speaker's crop, in source pixels, in SLOT order —
   * which is the order they sit along `axis`: left to right for "x", top to
   * bottom for "y". For a 2x2 grid that reads across the top row first, then
   * the bottom.
   */
  crops: { x: number; y: number }[];
  /**
   * When this stack is on screen, in seconds from the START OF THE CLIP (not of
   * the source). Disjoint, ascending, each at least MULTI_UP_MIN_RUN_S long,
   * and disjoint from every OTHER layout's ranges as well.
   */
  ranges: TimeRange[];
}

export interface MultiUpPlan {
  /**
   * Every stack this clip uses, dominant first.
   *
   * "Dominant" is the one the old single-layout planner would have picked: the
   * biggest group worth stacking, which owns its stretches outright. Any
   * smaller group only gets the stretches the dominant one does not want — see
   * `secondaryLayouts` for why that asymmetry is not arbitrary.
   */
  layouts: MultiUpLayout[];
  /**
   * The dominant layout's slot count, which is what a consumer that can only
   * hold one number reads. Every range carries its own `slots` too.
   */
  slots: number;
  /** Fraction of the clip's duration covered by ALL layouts together. */
  coverage: number;
  /**
   * True when the DOMINANT layout covers essentially the whole clip, i.e. the
   * source never cuts away from the group shot. The encode takes a cheaper path
   * and the composition pins the captions to the seam throughout. A clip with a
   * second layout in it is never `whole` — there was something else to show.
   */
  whole: boolean;
}

/** A half-open span of clip time, in seconds from the start of the clip. */
export interface TimeRange {
  start: number;
  end: number;
  /**
   * How many speakers the stack holds over this range — 2, 3 or 4.
   *
   * Present on every range a current encode produces. Absent on rows written
   * before a clip could change shape mid-clip, where the clip's single
   * `speakerSlots` is the answer for every range; consumers fall back to it.
   */
  slots?: number;
}

/** Total length of a set of disjoint ranges, in seconds. */
function totalSecs(ranges: TimeRange[]): number {
  return ranges.reduce((a, r) => a + Math.max(0, r.end - r.start), 0);
}

/** Every range a set of layouts already owns, ascending. */
function takenRanges(layouts: MultiUpLayout[]): TimeRange[] {
  return layouts.flatMap((l) => l.ranges).sort((a, b) => a.start - b.start);
}

/**
 * `ranges` with every part of `taken` cut out of it, keeping only what is still
 * long enough to cut to.
 *
 * A guard band on each side of the taken stretch, because a boundary is only
 * ever located to within one probe sample: without it a second layout could cut
 * in for the half second either side of a stretch the first one owns, which is
 * a flash of the wrong shape rather than a shot. MULTI_UP_MIN_RUN_S is what a
 * run has to be worth on its own, so a fragment shorter than that is dropped
 * rather than shown.
 */
function subtractRanges(ranges: TimeRange[], taken: TimeRange[]): TimeRange[] {
  const guard = MULTI_UP_MIN_RUN_S / 2;
  let out: TimeRange[] = ranges.map((r) => ({ ...r }));
  for (const t of taken) {
    const next: TimeRange[] = [];
    for (const r of out) {
      const lo = t.start - guard;
      const hi = t.end + guard;
      if (r.end <= lo || r.start >= hi) { next.push(r); continue; }
      if (r.start < lo) next.push({ start: r.start, end: lo });
      if (r.end > hi) next.push({ start: hi, end: r.end });
    }
    out = next;
  }
  return out
    .filter((r) => r.end - r.start >= MULTI_UP_MIN_RUN_S)
    .sort((a, b) => a.start - b.start);
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/** Nearest even integer inside [lo, hi] — 4:2:0 chroma needs even dimensions. */
function evenClamped(n: number, lo: number, hi: number): number {
  const clamped = Math.max(lo, Math.min(hi, Math.round(n)));
  return clamped - (clamped % 2);
}

/**
 * The largest cleanly-separated group of heads in one frame, in reading order,
 * plus the axis that separates them — or null if no two heads are far enough
 * apart to be two people.
 *
 * "Cleanly separated" means every ADJACENT pair is at least a separation
 * threshold apart ALONG ONE AXIS. Checking neighbours rather than all pairs is
 * what makes this work for three and four: two people at opposite ends of a
 * panel are trivially far apart, and the only distance that says anything about
 * whether the detector split one person in two is the distance to the person
 * beside them.
 *
 * ── Why the LARGEST SUBSET rather than all-or-nothing ──
 *
 * This used to demand that every head in the frame line up, and return null
 * otherwise. That works while the only thing on screen is the people, and fails
 * the moment the frame also contains a picture of people — a screen share, a
 * clip being reacted to, a video wall. Measured on the WATP source: the sliced
 * probe finds four heads on 21 of 28 samples, three of them the hosts in a
 * clean vertical rail and the fourth a man inside the video being shared. Those
 * four line up on no axis, so all-or-nothing threw away every frame of a clip
 * that is a three-shot from end to end.
 *
 * A layout is a set of tiles, and a head that fits no tile is not part of it.
 * Taking the largest subset that does line up says exactly that. Greedily
 * walking the sorted heads and keeping each one that clears the threshold from
 * the last kept is optimal for this — skipping an earlier head can never leave
 * room for more later ones — and it is unchanged for a frame that was already
 * clean, so every source that stacked before stacks identically now.
 *
 * The axis with the bigger group wins. A side-by-side two-shot separates on cx
 * by a mile and on cy not at all, so it never reaches the vertical rule. See
 * MULTI_UP_MIN_SEPARATION_V.
 *
 * ── Breaking a tie ──
 *
 * Two axes can offer the same number of people, and on the WATP source they
 * do: three hosts down the right-hand rail, and — reading across instead — two
 * men inside the shared video plus whichever host is nearest their eyeline.
 * Both are three cleanly separated heads; only one of them is the podcast.
 *
 * What tells them apart is the CROSS axis. A compositor lays its tiles out on a
 * line, so a real column of speakers shares an x to within a few pixels
 * (measured: 0.795/0.807/0.819, a spread of 0.024 of frame width) while the
 * accidental row is scattered down the frame (0.137/0.489/0.524, a spread of
 * 0.387 of frame height — sixteen times wider once both are put in the same
 * units). Straightness is the signal that these three boxes are one layout
 * rather than three things that happen to be spaced out.
 *
 * ── What may be left out, and what may not ──
 *
 * Taking the largest subset needs a guard, because a crowd also has a largest
 * subset. Measured on podcast4.mp4 — twelve people around a table, which the
 * old all-or-nothing rule refused outright — MoveNet resolves four or five of
 * them and three of those happen to be 0.18 apart, so subsetting alone would
 * stack three of twelve and drop nine people who are on screen throughout.
 *
 * What separates that from the rail is WHERE the left-out heads are. Around the
 * table they sit on the group's own line: the same cy, interleaved along cx,
 * because they are more of the same row of people. That is the frame telling us
 * the row has more people in it than we picked, and the old rule was right to
 * refuse it. Beside the rail the left-out heads sit nowhere near the line — the
 * two men inside the shared video are 0.29 of frame width off a column whose
 * own members share an x to within 0.024 — which is the frame telling us they
 * belong to something else that happens to be in shot.
 *
 * So a head may be left out only if it is further from the group's line than
 * the CROSS axis's own separation threshold, i.e. far enough that it would read
 * as a different row (for a column) or column (for a row). A frame with a
 * left-out head on the line is not a layout, and is rejected exactly as it was
 * before. A frame with nothing left out is unchanged by all of this, which is
 * every source that stacked before.
 */
function cleanGroup(
  faces: FaceBox[],
  srcW: number,
  srcH: number
): { faces: FaceBox[]; axis: StackAxis } | null {
  if (faces.length < MULTI_UP_MIN_SLOTS) return null;

  /** Spread of the group across the axis it is NOT separated along, in source pixels. */
  const crossSpread = (group: FaceBox[], axis: StackAxis): number => {
    const vals = group.map((f) => (axis === "x" ? f.cy * srcH : f.cx * srcW));
    return Math.max(...vals) - Math.min(...vals);
  };

  const candidate = (axis: StackAxis): FaceBox[] | null => {
    const along = (f: FaceBox) => (axis === "x" ? f.cx : f.cy);
    const cross = (f: FaceBox) => (axis === "x" ? f.cy : f.cx);
    const min = axis === "x" ? MULTI_UP_MIN_SEPARATION : MULTI_UP_MIN_SEPARATION_V;
    const tol = axis === "x" ? MULTI_UP_MIN_SEPARATION_V : MULTI_UP_MIN_SEPARATION;

    const sorted = [...faces].sort((a, b) => along(a) - along(b));
    const kept: FaceBox[] = [];
    for (const f of sorted) {
      if (kept.length === 0 || along(f) - along(kept[kept.length - 1]) >= min) kept.push(f);
    }
    if (kept.length < MULTI_UP_MIN_SLOTS) return null;

    const line = median(kept.map(cross));
    const dropped = faces.filter((f) => !kept.includes(f));
    if (dropped.some((f) => Math.abs(cross(f) - line) <= tol)) return null;
    return kept;
  };

  /**
   * The 2x2 case: four speakers a compositor has ALREADY laid out in a grid,
   * two columns of two, which is what a four-camera podcast recording looks
   * like before anything crops it. OpusClip calls this its "Four" layout and
   * gates it on the speakers "appearing together in the original video frame",
   * which is exactly the shape being matched here.
   *
   * Neither 1D candidate can see this shape. Sorting on x, the two left-hand
   * speakers share a column and the near-zero gap between them reads as
   * detector jitter, so one of them is dropped — and the same happens on the
   * right, so a four-shot comes out as a two-shot. Sorting on y does the same
   * thing to the rows. Measured on the Anuv Jain source (1920x1080, four
   * cameras in a 2x2): the heads sit at cx 0.234/0.738/0.254/0.738 and cy
   * 0.278/0.208/0.750/0.722, so the x gaps are 0.020, 0.484 and 0.000 — two of
   * the three an order of magnitude under MULTI_UP_MIN_SEPARATION. The clip
   * then read as a 2-up for 1.7s, missed MULTI_UP_MIN_TOTAL_S, and fell all
   * the way back to a single-speaker crop: four people on screen, one in the
   * output.
   *
   * So cluster BOTH axes instead of picking one — two columns separated by the
   * horizontal threshold, two rows by the vertical one, and exactly one face
   * per cell. Anything else is not a 2x2 and is left to the 1D candidates: a
   * straight row of four clusters into four columns, a rail into four rows,
   * and both fail the 2x2 test rather than being mangled by it.
   *
   * Returned in ROW-MAJOR order — top-left, top-right, bottom-left,
   * bottom-right — because that is the order `multiUpFilterComplex` reads
   * `crops` in when it builds its hstack rows.
   */
  const gridCandidate = (): FaceBox[] | null => {
    if (faces.length !== MULTI_UP_MAX_SLOTS) return null;
    /** Indices of `faces`, grouped into runs closer together than `min`. */
    const clusters = (vals: number[], min: number): number[][] => {
      const order = faces.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
      const out: number[][] = [];
      for (const i of order) {
        const last = out[out.length - 1];
        if (!last || vals[i] - vals[last[last.length - 1]] >= min) out.push([i]);
        else last.push(i);
      }
      return out;
    };
    const cols = clusters(faces.map((f) => f.cx), MULTI_UP_MIN_SEPARATION);
    const rows = clusters(faces.map((f) => f.cy), MULTI_UP_MIN_SEPARATION_V);
    if (cols.length !== 2 || rows.length !== 2) return null;
    if (cols.some((c) => c.length !== 2) || rows.some((r) => r.length !== 2)) return null;
    const ordered: FaceBox[] = [];
    for (const row of rows) {
      for (const col of cols) {
        const cell = row.filter((i) => col.includes(i));
        if (cell.length !== 1) return null;
        ordered.push(faces[cell[0]]);
      }
    }
    return ordered;
  };

  const asGrid = gridCandidate();
  const byX = candidate("x");
  const byY = candidate("y");
  // A 2x2 keeps all four speakers where the 1D pair can find at most two of
  // them, so it wins outright — the same "largest group takes the clip" rule
  // planMultiUp applies to its own candidates.
  if (asGrid) return { faces: asGrid, axis: "grid" };
  if (!byX && !byY) return null;
  if (!byY) return { faces: byX!, axis: "x" };
  if (!byX) return { faces: byY, axis: "y" };
  if (byX.length !== byY.length) {
    return byY.length > byX.length ? { faces: byY, axis: "y" } : { faces: byX, axis: "x" };
  }
  return crossSpread(byY, "y") < crossSpread(byX, "x")
    ? { faces: byY, axis: "y" }
    : { faces: byX, axis: "x" };
}

/** The separating coordinate of a head, for whichever axis won the group. */
function axisOf(axis: StackAxis, f: FaceBox): number {
  return axis === "x" ? f.cx : f.cy;
}

/**
 * The sampled frames holding a group of one particular size, turned into the
 * time ranges the stack is on screen for.
 *
 * Gaps shorter than `gapMergeS` are bridged first (a dropped detection is not a
 * cut), then runs shorter than MULTI_UP_MIN_RUN_S are dropped (a flash is not a
 * shot).
 *
 * A run i0..i1 becomes EXACTLY [i0/fps, i1/fps] — the timestamps of samples we
 * actually looked at — and is deliberately not widened by the half sample it
 * "speaks for". The source cuts into the group shot somewhere in the sample
 * before i0, and widening the range guesses where. Guessing wrong stacks a
 * close-up: measured on podcast-full.mp4, a half-sample lead-in put 0.4s of
 * top-half-face over bottom-half-light-stand at the head of every range,
 * because cropping "where the right speaker sits in the wide shot" out of a
 * close-up of the left speaker lands on the set. Snapping to verified samples
 * costs up to one sample of group shot at each end, which the single-speaker
 * camera covers with a real picture instead of half a wrong one.
 *
 * `longestRunS` is reported even when nothing survives, so a rejection can say
 * by how much the clip missed.
 */
/**
 * One group size's case for owning (some of) the clip: the frames it was seen
 * on, the stretches those frames make, and how much of the clip that is.
 */
interface Candidate {
  /** How many heads this reading of the clip holds. */
  size: number;
  axis: StackAxis;
  groups: { i: number; faces: FaceBox[] }[];
  kept: { from: number; to: number }[];
  ranges: TimeRange[];
  stackedSecs: number;
  longestRunS: number;
  whole: boolean;
}

function buildStackRanges(
  groups: { i: number; faces: FaceBox[] }[],
  perFrame: FaceBox[][],
  sampleDur: number,
  clipDur: number,
  axis: StackAxis
): Omit<Candidate, "size" | "axis" | "groups"> {
  const frames = perFrame.length;
  const isGroup = new Array<boolean>(frames).fill(false);
  for (const g of groups) isGroup[g.i] = true;

  // Where this group's heads sit and how big they are — the reference `sameShot`
  // compares a gap frame against. Medians, so one frame that latched onto a hand
  // cannot move it.
  //
  // Read along the SEPARATING axis, not always cx: on a vertical rail every
  // head shares a cx, so a cx-based reference would put all the slots on top of
  // each other, collapse the tolerance onto its floor, and pass any head
  // anywhere in the rail as "the same shot" — which is the opposite of the
  // evidence this test is supposed to demand.
  const slots = groups[0].faces.length;
  // A grid separates its speakers on BOTH axes at once, so "where slot k sits"
  // is a POINT and "how far away" is a distance. Only the grid takes the 2D
  // path: routing "x" and "y" through it would turn `spread` below from a range
  // into a radius and quietly halve every tolerance here, all of which were
  // tuned against real footage.
  const refPt = Array.from({ length: slots }, (_, k) => ({
    x: median(groups.map((g) => g.faces[k].cx)),
    y: median(groups.map((g) => g.faces[k].cy)),
  }));
  const gridDist = (ax: number, ay: number, bx: number, by: number) =>
    Math.hypot(ax - bx, ay - by);
  const refPos = axis === "grid" ? [] : Array.from({ length: slots }, (_, k) =>
    median(groups.map((g) => axisOf(axis, g.faces[k])))
  );
  const refH = median(groups.flatMap((g) => g.faces.map((f) => f.h)));
  /**
   * How far from `refPos[k]` a head may sit and still be speaker k.
   *
   * Half the tightest gap between two of the group's heads is the CEILING —
   * past it a head is nearer somebody else and calling it speaker k would be
   * arbitrary. That used to be the whole rule, and on a two-shot it is far too
   * generous: hosts at cx 0.33 and 0.77 give a tolerance of 0.22, a fifth of
   * the frame.
   *
   * Measured on a three-camera podcast (6d5hUnnU-3s): the source cuts to a solo
   * camera on a THIRD host, framed dead centre at cx 0.51. That is 0.18 from
   * the left host — inside 0.22 — so the cut passed as "still the same shot",
   * got bridged, and the clip stacked straight through it. Both bands then
   * showed that one man, because both crop windows were aimed at where the
   * other two sit in the wide shot.
   *
   * So the tolerance is this speaker's own observed spread instead. That is the
   * question actually being asked — not "could this plausibly be someone else"
   * but "has this head moved further than this head ever moves". The same left
   * host spans cx 0.30-0.35 across the group frames, so 0.18 is three times
   * anything he does and now reads as the different shot it is.
   *
   * Floored for a locked-off speaker who never moves, and capped by the half-gap
   * so a speaker who wanders can still never be confused with their neighbour.
   */
  // For a grid the ceiling is the distance to the nearest OTHER slot rather
  // than to the next one along a line — there is no "next" in two dimensions —
  // and the spread is a radius about the slot's own median. Same question as
  // the 1D case ("has this head moved further than this head ever moves"),
  // same floor, two axes.
  const halfGap = axis === "grid"
    ? Math.min(...refPt.flatMap((p, i) =>
        refPt.filter((_, j) => j !== i).map((q) => gridDist(p.x, p.y, q.x, q.y) / 2)))
    : Math.min(...refPos.slice(1).map((p, k) => (p - refPos[k]) / 2));
  const posTol = axis === "grid"
    ? refPt.map((p, k) => {
        const spread = Math.max(
          ...groups.map((g) => gridDist(g.faces[k].cx, g.faces[k].cy, p.x, p.y))
        );
        return Math.max(MULTI_UP_SAME_SHOT_CX_FLOOR, Math.min(halfGap, spread));
      })
    : refPos.map((_, k) => {
        const seen = groups.map((g) => axisOf(axis, g.faces[k]));
        const spread = Math.max(...seen) - Math.min(...seen);
        return Math.max(MULTI_UP_SAME_SHOT_CX_FLOOR, Math.min(halfGap, spread));
      });

  /**
   * Is this sampled frame consistent with the group shot — i.e. is there no
   * evidence the source cut away?
   *
   * A frame with nothing in it is not evidence of a cut, so it passes: MoveNet
   * finding no pose is the failure this whole bridge exists to survive, and the
   * stack over such a stretch is still a crop of the same source.
   */
  const isOneOfTheGroup = (b: FaceBox): boolean =>
    (axis === "grid"
      ? refPt.some((p, k) => gridDist(b.cx, b.cy, p.x, p.y) <= posTol[k])
      : refPos.some((p, k) => Math.abs(axisOf(axis, b) - p) <= posTol[k])) &&
    b.h <= refH * MULTI_UP_SAME_SHOT_H_RATIO &&
    b.h >= refH / MULTI_UP_SAME_SHOT_H_RATIO;

  /**
   * Nobody in this frame who is not one of the group.
   *
   * Weaker than `sameShot`: it does not care HOW MANY heads there are, only
   * that none of them is a stranger. A frame with nothing in it passes
   * vacuously, which is the point — MoveNet finding no pose is a dropout, not
   * evidence of a cut.
   */
  const noStranger = (i: number): boolean => perFrame[i].every(isOneOfTheGroup);

  const sameShot = (i: number): boolean => {
    const heads = perFrame[i];
    if (heads.length === 0) return true;
    if (heads.length > slots) return false;
    return heads.every(isOneOfTheGroup);
  };

  const runs: { from: number; to: number }[] = [];
  for (let i = 0; i < frames; i++) {
    if (!isGroup[i]) continue;
    const from = i;
    while (i + 1 < frames && isGroup[i + 1]) i++;
    runs.push({ from, to: i });
  }

  const merged: { from: number; to: number }[] = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    const gapS = prev ? (run.from - prev.to - 1) * sampleDur : Infinity;
    const gapFrames = prev
      ? Array.from({ length: run.from - prev.to - 1 }, (_, k) => prev.to + 1 + k)
      : [];
    // The short window is no longer bridged blind. It is sized for a dropout —
    // a hand across a face, someone leaning out of shot — and every one of those
    // leaves behind either an empty frame or the OTHER speaker where they
    // belong, both of which `noStranger` accepts. What it must not swallow is a
    // one-sample cut to a different camera, which is what a solo shot inside a
    // two-shot looks like at 1fps and is precisely the frame that carries a
    // stranger. It still ignores head COUNT, so a spurious extra detection can
    // no more split a run than it could before.
    const bridgeable =
      (gapS <= MULTI_UP_GAP_MERGE_S && gapFrames.every(noStranger)) ||
      (gapS <= MULTI_UP_GAP_BRIDGE_S && gapFrames.every(sameShot));
    if (prev && bridgeable) prev.to = run.to;
    else merged.push({ ...run });
  }

  const runSecs = (r: { from: number; to: number }) => (r.to - r.from) * sampleDur;
  const longestRunS = Math.max(0, ...merged.map(runSecs));
  const kept = merged.filter((r) => runSecs(r) >= MULTI_UP_MIN_RUN_S);

  // Reach the outermost surviving run out to the clip's edge across a dropout,
  // so that `whole` below — an exact test — is not defeated by the sampling
  // grid missing the group on the very first or very last frame.
  //
  // Three restrictions, and each one is load-bearing:
  //   - AFTER the length filter, never before. Snapping a run that was too
  //     short to keep would manufacture one that is long enough. On a clip
  //     where MoveNet resolved the group in a single frame and nothing at all
  //     in the other 26, snapping first turned that one frame into a 19-second
  //     two-shot; the clip is a screen share whose hosts the whole-frame pass
  //     cannot see, and the honest answer is the null it used to give.
  //   - MULTI_UP_GAP_MERGE_S at most, which is one sample at the probe rate.
  //     A dropout is all this is for. Bridging between two runs may reach much
  //     further because the group is confirmed on BOTH sides of the gap; here
  //     there is confirmation on one side only, and empty frames beyond the
  //     edge of a clip are not evidence that the group was still there.
  //   - `noStranger`, so it cannot reach across a frame holding somebody who
  //     is not in the group.
  const snapFrames = Math.floor(MULTI_UP_GAP_MERGE_S / sampleDur);
  if (kept.length > 0 && snapFrames > 0) {
    const first = kept[0];
    for (let n = 0; n < snapFrames && first.from > 0 && noStranger(first.from - 1); n++) first.from--;
    const last = kept[kept.length - 1];
    for (let n = 0; n < snapFrames && last.to < frames - 1 && noStranger(last.to + 1); n++) last.to++;
  }
  const clamp = (t: number) => Math.max(0, Math.min(clipDur, t));
  const ranges: TimeRange[] = kept.map((r) => ({
    start: clamp(r.from * sampleDur),
    end: clamp(r.to * sampleDur),
  }));
  const stackedSecs = ranges.reduce((a, r) => a + (r.end - r.start), 0);
  /**
   * One stretch, covering every sampled frame — the source never cuts away.
   *
   * Exact, and deliberately so. This was `coverage >= 0.9`, which is a
   * different claim: it says most of the clip is a group shot, and then the
   * encode threw the ranges away and stacked ALL of it. A clip that is a
   * two-shot for 38 of its 40 seconds is 95% covered and would stack the two
   * seconds where the source cut to somebody else — with the crop windows still
   * aimed at the two people who are no longer there. That is the "same speaker
   * in both halves" artefact, and no threshold short of 1.0 rules it out.
   *
   * Costs nothing when the clip really is a whole-clip stack: the edge snapping
   * above absorbs the sampling artefacts that used to need the 10% slack.
   */
  const whole = kept.length === 1 && kept[0].from === 0 && kept[0].to === frames - 1;
  return { kept, ranges, stackedSecs, longestRunS, whole };
}

/**
 * Find the stretches of a clip that are a genuine group shot, how many people
 * are in it, and where to crop each of them.
 *
 * Returns null when there is nothing to stack — one speaker, a crowd of five or
 * more, or people who never actually share the frame — and the caller falls
 * through to the single-speaker camera for the whole clip. Pure, so the
 * decision can be exercised without MoveNet.
 *
 * @param perFrame one entry per sampled frame, holding every head found in it
 * @param probeFps the rate `perFrame` was sampled at — the only thing that
 *                 turns a frame index into a timestamp
 * @param clipDur  clip length in seconds, so a range can be clamped to it
 */
export function planMultiUp(
  perFrame: FaceBox[][],
  srcW: number,
  srcH: number,
  probeFps: number,
  clipDur: number
): MultiUpPlan | null {
  // Every rejection says why. A bare `return null` made a group shot that failed
  // to stack indistinguishable from one that was never a group shot — there was
  // nothing in the logs to tell which gate had turned it down, or by how much.
  const reject = (why: string): null => {
    console.log(`[facetrack] Not stacking (single-speaker camera): ${why}`);
    return null;
  };

  const frames = perFrame.length;
  if (frames === 0) return reject("no sampled frames");
  if (!(probeFps > 0)) return reject("probe frame rate unknown");

  // Past PROBE_SAMPLES_MAX the sample spacing stretches to keep the cost fixed,
  // and a range boundary can only be placed as finely as the clip was sampled.
  // Once a single sample is longer than the shortest stack we would cut to,
  // every range edge is a guess of that size — so stop guessing. A clip that
  // long is not what the stack is for anyway.
  const sampleDur = 1 / probeFps;
  if (sampleDur > MULTI_UP_MIN_RUN_S) {
    return reject(
      `clip too long to place a boundary — sampled every ${sampleDur.toFixed(1)}s, ` +
      `coarser than the ${MULTI_UP_MIN_RUN_S}s minimum stack`
    );
  }

  // ── How many people is this clip? ─────────────────────────────────────────
  //
  // Bucket every sampled frame by how many cleanly-separated heads it holds,
  // then let the buckets argue it out below. A frame that holds more people
  // than the grid has slots is a crowd and votes only against stacking.
  // Keyed by size AND axis. A frame that reads as three people down a rail and
  // one that reads as three people across a panel are not the same shot, and
  // averaging their geometry together would size one box for neither — the same
  // mistake as mixing a wide shot's heads with a close-up's. In practice a
  // source has one layout and one of the two buckets stays empty; when both
  // fill, they compete on stacked seconds like any other pair of candidates.
  const groupsByKey = new Map<string, { axis: StackAxis; size: number; groups: { i: number; faces: FaceBox[] }[] }>();
  let crowdedFrames = 0;
  let multiFrames = 0;
  let tooCloseFrames = 0;
  for (let i = 0; i < frames; i++) {
    const f = perFrame[i];
    if (f.length < MULTI_UP_MIN_SLOTS) continue;
    multiFrames++;
    const group = cleanGroup(f, srcW, srcH);
    if (!group) {
      // A frame that will not read as a layout AT ALL, while holding more heads
      // than the grid has slots, is evidence of a crowd — not merely of one
      // close pair. That is what the raw-count test used to say, and it has to
      // keep saying it: on podcast4.mp4 the five-head frames are the only thing
      // standing between a twelve-person table and a stack of three of them.
      if (f.length > MULTI_UP_MAX_SLOTS) crowdedFrames++;
      else tooCloseFrames++;
      continue;
    }
    // A crowd is more people than the grid can hold IN ONE LAYOUT, which is a
    // question about the group's own line rather than about the raw detection
    // count. Asking it of the raw count was right while every head on screen was
    // a participant, and wrong as soon as the frame could also contain a picture
    // of people: on the WATP source the sliced probe returns five heads on 25 of
    // 28 samples — three hosts in a rail plus two men inside the shared video —
    // and calling that a five-person panel threw away a clip that is a
    // three-shot throughout. `cleanGroup` has already refused any frame whose
    // left-out heads sit on the group's line, so what reaches here is a layout,
    // and the only question left is whether the layout itself is too big.
    if (group.faces.length > MULTI_UP_MAX_SLOTS) { crowdedFrames++; continue; }
    const size = group.faces.length;
    const key = `${size}${group.axis}`;
    const bucket = groupsByKey.get(key) ?? { axis: group.axis, size, groups: [] };
    bucket.groups.push({ i, faces: group.faces });
    groupsByKey.set(key, bucket);
  }

  if (multiFrames === 0) {
    return reject(`never more than one person on screen in ${frames} sampled frames`);
  }
  if (groupsByKey.size === 0) {
    return reject(
      `no clean group frame — ${multiFrames} frame(s) held 2+ people but ` +
      `${crowdedFrames} were crowded and ${tooCloseFrames} had two neighbours closer than ` +
      `${(MULTI_UP_MIN_SEPARATION * 100).toFixed(0)}% of frame width side by side ` +
      `and ${(MULTI_UP_MIN_SEPARATION_V * 100).toFixed(0)}% of frame height stacked`
    );
  }

  // ── Which size wins ───────────────────────────────────────────────────────
  //
  // Every size present is turned into ranges, and they are compared on the one
  // thing that matters: how many SECONDS of stack each would actually put on
  // screen. Comparing raw sample counts instead was wrong on the case this
  // feature was asked for. On the NFL three-panel clip (70s, three people on
  // screen nearly throughout) MoveNet reports 2 heads on 21 samples and 3 on
  // only 9 — it drops whoever is momentarily not pose-like, and headFromPose
  // loses nothing on top of that (measured: poses-per-frame and
  // heads-per-frame are identical, and probing at 1280 instead of 640 made it
  // worse, 7 instead of 9). By sample count 3-up loses 9 to 21 and two of the
  // three men get stacked. By stacked seconds the 9 three-shot samples merge
  // into one continuous 10s stretch against the two-shot's scattered 9s, and
  // 3-up wins — which is the right answer and the one a viewer would give.
  //
  // The larger size takes the clip when it is within MULTI_UP_UPGRADE_FRAC of
  // the best, rather than only when it beats it: dropping somebody who is on
  // screen is worse than a slightly shorter stack. Frames that saw N people are
  // evidence that N are there; frames that saw N-1 are not evidence that the
  // Nth is absent.
  const candidates = [...groupsByKey.values()]
    .map(({ size, axis, groups }) => {
      const built = buildStackRanges(groups, perFrame, sampleDur, clipDur, axis);
      return { size, axis, groups, ...built };
    })
    // Largest group first, and within a size the axis that puts more stack on
    // screen — otherwise a handful of frames that happened to read as a rail
    // could outrank the panel the clip actually is, purely on map order.
    .sort((a, b) => b.size - a.size || b.stackedSecs - a.stackedSecs);

  const summary = candidates
    .map((c) => `${c.size}-up/${c.axis}×${c.groups.length}=${c.stackedSecs.toFixed(1)}s`)
    .join(", ") + (crowdedFrames ? `, crowded×${crowdedFrames}` : "");

  const viable = candidates.filter((c) => c.stackedSecs >= MULTI_UP_MIN_TOTAL_S);
  if (viable.length === 0) {
    const longest = Math.max(0, ...candidates.map((c) => c.longestRunS));
    return reject(
      `no group shot long enough to cut to — ${summary} over ${frames} samples in a ` +
      `${clipDur.toFixed(1)}s clip (longest single stretch ${longest.toFixed(1)}s; ` +
      `need runs of ${MULTI_UP_MIN_RUN_S}s totalling ${MULTI_UP_MIN_TOTAL_S}s)`
    );
  }

  const bestSecs = Math.max(...viable.map((c) => c.stackedSecs));
  // `viable` is already largest-size-first, so the first one clearing the bar is
  // the biggest group worth stacking.
  const chosen = viable.find((c) => c.stackedSecs >= MULTI_UP_UPGRADE_FRAC * bestSecs)!;

  // ── More people than the grid can hold ────────────────────────────────────
  //
  // The mirror of the upgrade rule above, and it has to be: seeing five people
  // is evidence there are five, exactly as seeing three is evidence there are
  // three, and not seeing the fifth is not evidence they left. So a crowd wins
  // the clip on the same terms a larger group does — it only has to come close.
  //
  // This replaced a flat "reject if over 35% of multi-person frames are
  // crowded", which had the recall problem backwards. MoveNet resolves fewer
  // people the more of them there are, so on a six-person panel it reports
  // three or four on most frames and five-plus on a minority; that minority
  // could sit under 35% while being the only honest reading of the shot, and
  // the flat gate would have stacked four of the six and silently dropped two.
  //
  // Counted in frames rather than in seconds, unlike the sizes above, because
  // a crowd has no grid and therefore no ranges to measure. The question is
  // only "are there more people here than four", and frames answer it.
  if (crowdedFrames >= MULTI_UP_CROWD_FRAC * chosen.groups.length) {
    return reject(
      `crowd — ${crowdedFrames} sampled frame(s) hold more than ${MULTI_UP_MAX_SLOTS} people ` +
      `against ${chosen.groups.length} holding ${chosen.size}; there is no grid for that many, ` +
      `so the single-speaker camera follows whoever is talking instead`
    );
  }

  /**
   * The finished stack for one candidate: its box size, its N crop windows and
   * the stretches it is on screen for. Null when the candidate cannot be framed,
   * with the reason logged.
   *
   * A closure rather than a free function because everything it measures is a
   * property of THIS clip — the source size, the sampled frames, the reject
   * logger — and passing eight of those through a signature buys nothing.
   */
  const buildLayout = (cand: Candidate, ranges: TimeRange[]): MultiUpLayout | null => {
    const { size: slots, axis, groups, kept } = cand;
    const stackedSecs = totalSecs(ranges);

    const { cols, rows, slotW, slotH } = slotGeometry(slots);
    const slotAspect = slotW / slotH;

    // ── Geometry, measured ONLY inside the kept ranges ────────────────────────
    //
    // This is the other half of the old bug. Sizing and placing the boxes from
    // every detection in the clip mixed the wide shot's small heads with the
    // close-ups' large ones, so an intercut source produced a box sized for
    // neither. A close-up frame says nothing about where the speakers sit in the
    // wide shot, so it does not get a vote.
    const inKept = (i: number) =>
      kept.some((r) => i >= r.from && i <= r.to) &&
      ranges.some((t) => i * sampleDur >= t.start - sampleDur && i * sampleDur <= t.end + sampleDur);
    const used = groups.filter((g) => inKept(g.i));
    if (used.length === 0) return reject(`${slots}-up: no measured frame inside its own stretches`);
    /** Every measurement of the person in slot k, over the frames we kept. */
    const perSlot: FaceBox[][] = Array.from({ length: slots }, (_, k) => used.map((g) => g.faces[k]));

    // Median throughout, for the reason the camera path uses one: a single box
    // latched onto a hand or a bystander must not move the framing.
    const faceH = median(perSlot.map((boxes) => median(boxes.map((f) => f.h))));
    if (!(faceH > 0)) return reject("measured face height was zero");

    // ── The crop is ALWAYS the slot's shape ───────────────────────────────────
    //
    // No pillarbox, no blurred backdrop: every crop is scaled straight into its
    // slot and fills it edge to edge. That makes WIDTH the only free variable —
    // height follows from it — and it makes the two competing pressures explicit:
    //
    //   want:  a width that puts the head at MULTI_UP_FACE_TARGET_H of the slot
    //   cap:   a width that stops before the neighbour's face begins
    //
    // Wider than the cap and the band shows two people. Narrower than the want
    // and the head is bigger than the slot, so the crop becomes a tight portrait
    // of the face rather than a head-and-shoulders shot. On a source where the
    // speakers sit far apart the cap never binds and the want is met exactly; on
    // a tightly-packed panel layout the cap wins and the bands go close-up.
    //
    // ── The want ──
    //
    // A crop `boxW` wide scales into the slot by slotW/boxW, and because the crop
    // is the slot's shape that is the same as slotH/boxH. So a head `faceHPx`
    // tall lands at `faceHPx * slotAspect / boxW` of the slot's height, and
    // solving that for the target gives the width below. For a wide two-shot
    // (heads 0.115 of a 1080p frame) it comes out at 465x413 — the framing every
    // two-speaker clip has shipped with, unchanged.
    const targetH = MULTI_UP_FACE_TARGET_H[slots] ?? 0.30;
    const faceHPx = faceH * srcH;
    const wantW = (faceHPx * slotAspect) / targetH;

    // ── The cap ──
    //
    // Measured on a 1280x720 three-panel podcast master (three portrait panels
    // side by side, heads 0.51 of frame height, ~409px between adjacent heads):
    // the want asked for a 1004px-wide crop out of 1280, so all three bands came
    // out as the same shot of two men and the stack said nothing the source had
    // not already said.
    //
    // So cap the width where the NEAREST NEIGHBOUR'S FACE starts. For each
    // speaker, how far their window may reach from their own centre is whichever
    // runs out first:
    //
    //   - the gap to a neighbour, less half that neighbour's face;
    //   - the distance to the edge of the source.
    //
    // The frame edge belongs in that list because a window is clamped inside the
    // source, and a clamped window is no longer centred on its speaker — it
    // slides inward, straight into the neighbour it was sized to clear. Leaving
    // it out sized the box off the middle speaker, whose neighbours are both far
    // away, and the right-hand speaker's window then slid 97px left and took half
    // the middle speaker's face with it.
    //
    // One box size positioned N times is what keeps every head at the same scale,
    // so the cap is the tightest speaker's, not each speaker's own — and it has a
    // floor, because a cap narrower than the face it is supposed to contain is
    // not a crop of a person, it is a crop of a nose.
    //
    // ── …along whichever axis actually separates the speakers ──
    //
    // On a vertical rail the neighbour to clear is the one ABOVE and BELOW, and
    // the horizontal distance to it is zero — feeding cx to the cap there asks
    // the crop to stop before a face it is already centred on, which comes out
    // negative and collapses the box onto the MIN_CROP_FACE_WIDTHS floor: a crop
    // of a nose, three times over. So the room is measured along the separating
    // axis, in that axis's units, and converted back to a width at the end. The
    // crop is always the slot's shape, so a height cap IS a width cap.
    const faceWPx = faceHPx / HEAD_ASPECT;
    const cxs = perSlot.map((boxes) => median(boxes.map((f) => f.cx)));
    const cys = perSlot.map((boxes) => median(boxes.map((f) => f.cy)));
    const horizontal = axis === "x";
    const isGrid = axis === "grid";

    // ── Cells, for a 2x2 ──
    //
    // What a grid crop must stop at is not a neighbour's FACE but the panel
    // SEAM: reach past it and the band shows a slice of the next camera's
    // picture, which is the very thing a stacked frame exists to remove. (That
    // artefact is visible on the pre-fix output of the Anuv Jain clip — the
    // middle band carries the red wall and the black seam of the panel beside
    // it.) The seam sits midway between the two column centres, and between the
    // two row centres, read from the medians rather than assumed at the halfway
    // line: a compositor is free to make its panels unequal, and this source's
    // other layouts do exactly that.
    //
    // Row-major, matching `crops`: slot k is at column k % 2, row floor(k / 2).
    // Midway between the two column centres is only an ESTIMATE of the seam, and
    // it is biased by wherever the speakers happen to sit inside their panels: on
    // the 20:14 shot the four faces put it at 0.48 of frame height against a true
    // seam at 0.50, which leaves a 22px ribbon of the upper panel along the top of
    // each lower cell. A compositor laying out four equal cameras splits evenly,
    // so snap to the exact half whenever the estimate is already near it, and
    // keep the estimate only for a grid that really is lopsided.
    const snapSeam = (est: number) =>
      Math.abs(est - 0.5) <= MULTI_UP_SEAM_SNAP ? 0.5 : est;
    const xSeam = isGrid
      ? snapSeam((median([cxs[0], cxs[2]]) + median([cxs[1], cxs[3]])) / 2) * srcW : 0;
    const ySeam = isGrid
      ? snapSeam((median([cys[0], cys[1]]) + median([cys[2], cys[3]])) / 2) * srcH : 0;
    const cellOf = (k: number) => ({
      x0: k % 2 === 0 ? 0 : xSeam,
      x1: k % 2 === 0 ? xSeam : srcW,
      y0: k < 2 ? 0 : ySeam,
      y1: k < 2 ? ySeam : srcH,
    });

    // Extent of the source along the separating axis, the half-width of a face
    // measured across that axis, and how a span along it becomes a crop width.
    const span = horizontal ? srcW : srcH;
    const halfFace = (horizontal ? faceWPx : faceHPx) / 2;
    const toWidth = (alongAxis: number) => (horizontal ? alongAxis : alongAxis * slotAspect);
    const centres = (horizontal ? cxs : cys).map((v) => v * span);
    const halfAvail = centres.map((px, k) => {
      const limits = [px, span - px];
      if (k > 0) limits.push(px - centres[k - 1] - halfFace);
      if (k < centres.length - 1) limits.push(centres[k + 1] - px - halfFace);
      return Math.min(...limits);
    });
    const capW = isGrid
      // The widest slot-shaped box that fits inside a cell, taken over the
      // TIGHTEST cell so every head still comes out at one scale — the same
      // "one box size positioned N times" rule the 1D cap follows.
      //
      // Deliberately WITHOUT the MULTI_UP_MIN_CROP_FACE_WIDTHS floor that the 1D
      // cap carries. A cell edge is not a neighbour's face, it is the edge of
      // another camera's picture, so crossing it does not merely crowd the band —
      // it puts a strip of a different shot in it. That is the case the 1D cap's
      // own note already settles ("Letting the floor win there would put a sliver
      // of the neighbour back in the band for nothing"), and it binds here far
      // more often: a 960x540 panel holding a head 0.27 of frame height cannot
      // give a 9:16 crop 1.6 face-widths wide without overflowing, so the floor
      // would win on ordinary footage rather than in a corner. Measured on the
      // 20:14 shot of the Anuv Jain source: the floor asked for 330x586 out of a
      // 540-tall cell and pulled 46px of the panel above into both lower cells.
      // A slightly tight head is a framing opinion; a seam is a bug.
      ? Math.min(...Array.from({ length: slots }, (_, k) => {
          const c = cellOf(k);
          return Math.min(c.x1 - c.x0, (c.y1 - c.y0) * slotAspect);
        }))
      : Math.max(
          faceWPx * MULTI_UP_MIN_CROP_FACE_WIDTHS,
          toWidth(2 * Math.min(...halfAvail))
        );

    // ── Resolving them ──
    //
    // The cap outranks the sharpness floor. MULTI_UP_MAX_UPSCALE is a quality
    // guard — it stops a bad measurement zooming to a nostril — while the cap is
    // a correctness one, and on the panel master the two disagree by 10px
    // (a 2.56x upscale instead of 2.5x, which lanczos will not show you). Letting
    // the floor win there would put a sliver of the neighbour back in the band
    // for nothing.
    const floorW = Math.min(slotW / MULTI_UP_MAX_UPSCALE, capW);
    let boxW = evenClamped(Math.max(Math.min(wantW, capW), floorW), 2, srcW);
    let boxH = evenClamped(boxW / slotAspect, 2, srcH);
    // A crop taller than the source has to give width back to keep the slot's
    // shape — only a portrait slot (the 2x2 cell) can reach this.
    if (boxW / slotAspect > srcH) {
      boxH = evenClamped(srcH, 2, srcH);
      boxW = evenClamped(boxH * slotAspect, 2, srcW);
    }

    // A box that can hold the whole head gets headroom; one that cannot is aimed
    // at the eyes and the mouth instead. See MULTI_UP_FACE_IN_BOX_TIGHT.
    const faceInBox = boxH >= faceHPx ? MULTI_UP_FACE_IN_BOX : MULTI_UP_FACE_IN_BOX_TIGHT;
    const place = (cx: number, cy: number, k: number) => {
      // A grid window is clamped inside its OWN cell; every other layout is
      // clamped inside the source, which is what the whole-frame bounds below
      // amount to.
      const c = isGrid ? cellOf(k) : { x0: 0, x1: srcW, y0: 0, y1: srcH };
      return {
        x: evenClamped(cx * srcW - boxW / 2, c.x0, Math.max(c.x0, c.x1 - boxW)),
        y: evenClamped(cy * srcH - faceInBox * boxH, c.y0, Math.max(c.y0, c.y1 - boxH)),
      };
  };
  // ── Squaring up a column ──────────────────────────────────────────────────
  //
  // A vertical rail is drawn by a compositor, so its tiles share an x exactly.
  // The faces inside them do not: a host who leans left sits 0.024 of frame
  // width off his neighbours (measured on WATP — 46px, a tenth of the crop),
  // and centring his window on his own face slid it off the left edge of his
  // tile and put a strip of the shared screen beside him in the top band.
  //
  // Where the crop is nearly as wide as the tile, following the face buys no
  // framing — there is nowhere to move to — and costs the tile edge. So the
  // column takes ONE cross-axis position, the median, and the bands line up.
  //
  // Gated on the spread being small enough to be layout noise rather than a
  // real difference: two people genuinely at opposite corners form a "vertical"
  // group too, and snapping those to a common x would frame both of them wrong.
  // Only the rail case — everyone within a quarter of a crop of each other —
  // gets squared up, and only for a column, because a row of speakers is
  // usually one real camera shot in which people are honestly different heights.
  const alignCross = axis === "y" &&
    (Math.max(...cxs) - Math.min(...cxs)) * srcW < boxW * MULTI_UP_CROSS_ALIGN_FRAC;
  const colCx = median(cxs);
  const crops = perSlot.map((_, k) => place(alignCross ? colCx : cxs[k], cys[k], k));

  // Every window is clamped inside the source, so on a narrow source adjacent
  // ones can collapse onto nearly the same place — a "stack" that is the same
  // picture twice is worse than the single-speaker camera, not better.
  //
  // Measured along the separating axis for the same reason the cap is: two
  // windows on a vertical rail share an x by construction, and comparing x
  // there would reject every rail that ever framed correctly.
  // Grid windows live in different cells by construction and so cannot
  // collapse onto each other; there is nothing here for them to fail.
  const minWindowGapPx = (MULTI_UP_MIN_WINDOW_GAP_NUM / slots) * span;
  for (let k = 1; !isGrid && k < crops.length; k++) {
    const a = crops[k], b = crops[k - 1];
    const gap = Math.abs((horizontal ? a.x : a.y) - (horizontal ? b.x : b.y));
    if (gap < minWindowGapPx) {
      return reject(
        `two of the ${slots} crop windows would overlap almost exactly ` +
        `(${gap.toFixed(0)}px apart on the ${axis} axis of a ${srcW}x${srcH} source, ` +
        `need ${minWindowGapPx.toFixed(0)}px)`
      );
    }
  }

  console.log(
    `[facetrack] ${slots}-shot on ${axis} (${cols}×${rows} grid, ${slotW}×${slotH} slots, ` +
    `${boxW}×${boxH} crops, head ${((faceHPx / boxH) * 100).toFixed(0)}% of a slot) in ` +
    `${ranges.length} stretch(es) totalling ${stackedSecs.toFixed(1)}s ` +
    `of ${clipDur.toFixed(1)}s (${((stackedSecs / Math.max(clipDur, 1e-9)) * 100).toFixed(0)}%): ` +
    ranges.map((r) => `${r.start.toFixed(1)}–${r.end.toFixed(1)}s`).join(", ")
  );

  return { slots, axis, boxW, boxH, crops, ranges: ranges.map((r) => ({ ...r, slots })) };
  };

  console.log(`[facetrack] Group sizes: ${summary} -> ${chosen.size} slot(s) separated on ${chosen.axis}.`);

  const dominant = buildLayout(chosen, chosen.ranges);
  if (!dominant) return null;

  // ── The other shapes this clip cuts to ────────────────────────────────────
  //
  // A podcast master is not one shot. The source that prompted this cuts
  // between a two-shot of the guests and a wide that also holds the host, so
  // "how many people is this clip?" has two right answers and the clip wants
  // both: 50/50 while two are on screen, three equal bands while three are.
  // Picking one count for the whole clip left ten seconds of a clean two-shot
  // to the single-speaker camera, which is exactly the shot the stack exists
  // to replace.
  //
  // The dominant layout still owns its stretches OUTRIGHT, and the asymmetry is
  // deliberate. MoveNet drops a person who leans out of frame or turns away, so
  // a genuine three-shot reports two heads on a good fraction of its samples —
  // that is why the larger group wins the clip in the first place. Those
  // two-head samples are misses, not a two-shot, and stacking them would drop
  // somebody who is on screen. Subtracting the dominant layout's ranges removes
  // them by construction: they sit inside a stretch it already owns.
  //
  // What survives is a stretch where the dominant group was NOT seen for long
  // enough to bridge — a real cut to a different shot — and it has to clear the
  // same two bars any stack does, a run of MULTI_UP_MIN_RUN_S and a total of
  // MULTI_UP_MIN_TOTAL_S, before it is worth cutting to.
  const layouts: MultiUpLayout[] = [dominant];
  if (!chosen.whole) {
    // Best by the time it would actually add, not by group size: a three-shot
    // glimpsed for two seconds must not outrank the ten seconds of two-shot the
    // clip is really made of, which sorting by size would do.
    const runnerUp = viable
      .filter((c) => c !== chosen && c.size !== chosen.size)
      .map((c) => ({ cand: c, free: subtractRanges(c.ranges, dominant.ranges) }))
      .filter((c) => totalSecs(c.free) >= MULTI_UP_MIN_TOTAL_S)
      .sort((a, b) => totalSecs(b.free) - totalSecs(a.free))[0];
    // One extra shape, not every shape that cleared the bar. Two is what a real
    // master gives you — a two-shot and the wide that adds the host — and each
    // one costs its own crops, scales and overlay in a graph that already has a
    // camera in it. A clip that genuinely changes shape three times in thirty
    // seconds is a montage, and the single-speaker camera is the better answer
    // for the third shape than a third layout is.
    const layout = runnerUp ? buildLayout(runnerUp.cand, runnerUp.free) : null;
    if (layout) layouts.push(layout);
  }

  const stackedTotal = totalSecs(takenRanges(layouts));
  const coverage = clipDur > 0 ? Math.min(1, stackedTotal / clipDur) : 0;
  if (layouts.length > 1) {
    console.log(
      `[facetrack] Clip changes shape: ` +
      layouts.map((l) => `${l.slots}-up ${totalSecs(l.ranges).toFixed(1)}s`).join(" + ") +
      ` = ${(coverage * 100).toFixed(0)}% of ${clipDur.toFixed(1)}s.`
    );
  }

  return { layouts, slots: dominant.slots, coverage, whole: chosen.whole };
}

/**
 * Coverage below which a whole-frame plan is treated as a misread and the
 * sliced probe is run to check it. See the use site.
 */
const MULTI_UP_RESLICE_COVERAGE = 0.5;

/**
 * The better of two plans for the same clip, either of which may be null.
 *
 * More stacked time wins, because that is the measure the group-size choice
 * inside `planMultiUp` already uses and for the same reason: what matters is
 * how much of the clip the stack is actually on screen for. Where the two are
 * within MULTI_UP_UPGRADE_FRAC of each other the one holding more people wins,
 * which is the same tie-break, one level up — dropping somebody who is on
 * screen is worse than a slightly shorter stack.
 */
function betterPlan(a: MultiUpPlan | null, b: MultiUpPlan | null): MultiUpPlan | null {
  if (!a) return b;
  if (!b) return a;
  const close = Math.min(a.coverage, b.coverage) >= MULTI_UP_UPGRADE_FRAC * Math.max(a.coverage, b.coverage);
  if (close && a.slots !== b.slots) return a.slots > b.slots ? a : b;
  return b.coverage > a.coverage ? b : a;
}

/** `between(t,a,b)+between(t,c,d)` — ffmpeg's `enable` is boolean-as-arithmetic. */
function enableExpr(ranges: TimeRange[]): string {
  return ranges.map((r) => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`).join("+");
}

/**
 * ffmpeg graph that crops every speaker to one slot and assembles the grid.
 *
 * With `baseParts` the stack is composited ON TOP of another 1080x1920 picture
 * — the single-speaker camera, or the blurred-background fallback — and shown
 * only during `plan.ranges`. `baseParts` must consume `[base]` and produce
 * `[single]`; everything else about the graph is the same either way.
 *
 * Exported as a test seam, like `planCropXExpr`: a graph that ffmpeg rejects
 * fails the whole encode, and that is worth being able to run without MoveNet.
 */
export function multiUpFilterComplex(
  plan: MultiUpPlan,
  hasAudio: boolean,
  baseParts?: string[]
): string {
  const layouts = plan.layouts.filter((l) => l.ranges.length > 0);
  const composited = baseParts !== undefined && layouts.length > 0;
  if (layouts.length === 0) throw new Error("multiUpFilterComplex: plan has no layouts");
  if (!composited && layouts.length > 1) {
    // A whole-clip stack has nothing to cut to by definition, so a second
    // layout can only reach here through a caller that dropped the base chain.
    throw new Error("multiUpFilterComplex: several layouts need a base to switch between");
  }

  // Every slot of every layout takes its own copy of the source, plus one for
  // the base picture the stacks are switched on top of. They all read the same
  // input at the same instant — a stack is a crop of the frame that is already
  // on screen — so one `split` feeds the lot.
  const slotCount = layouts.reduce((a, l) => a + l.crops.length, 0);
  const slotLabels: string[] = [];
  layouts.forEach((l, li) => l.crops.forEach((_, i) => slotLabels.push(`[s${li}_${i}]`)));

  const parts = composited
    ? [`[0:v]setpts=PTS-STARTPTS,split=${slotCount + 1}[base]${slotLabels.join("")}`, ...baseParts!]
    : [`[0:v]setpts=PTS-STARTPTS,split=${slotCount}${slotLabels.join("")}`];

  layouts.forEach((layout, li) => {
    const { cols, rows, slotW, slotH } = slotGeometry(layout.slots);

    // setsar=1 after each scale: the crops are not square-pixel by construction,
    // and hstack/vstack refuse to join inputs whose sample aspect ratios disagree.
    // One plain crop-and-scale per slot — the crop is already the slot's shape,
    // so it fills it exactly and there is nothing to pad, letterbox or blur.
    layout.crops.forEach((c, i) => {
      parts.push(
        `[s${li}_${i}]crop=${layout.boxW}:${layout.boxH}:${c.x}:${c.y},` +
          `scale=${slotW}:${slotH}:flags=lanczos,setsar=1[c${li}_${i}]`
      );
    });

    // Rows first, then the rows on top of each other. A 1-column grid skips the
    // hstack and vstacks the cells directly, which is byte-identical to the graph
    // the two-speaker stack has always emitted.
    const stackOut = composited ? `[stack${li}]` : "[outv]";
    const rowLabels: string[] = [];
    for (let r = 0; r < rows; r++) {
      const cells = Array.from({ length: cols }, (_, c) => `[c${li}_${r * cols + c}]`).join("");
      if (cols === 1) { rowLabels.push(cells); continue; }
      parts.push(`${cells}hstack=inputs=${cols},setsar=1[r${li}_${r}]`);
      rowLabels.push(`[r${li}_${r}]`);
    }
    if (rows === 1) {
      // Cannot happen with MULTI_UP_MIN_SLOTS = 2, but a single-row grid would
      // otherwise emit a vstack with one input, which ffmpeg rejects.
      parts.push(`${rowLabels[0]}null${stackOut}`);
    } else {
      parts.push(
        `${rowLabels.join("")}vstack=inputs=${rows}` +
        (composited ? `,setsar=1[stack${li}]` : "[outv]")
      );
    }
  });

  if (composited) {
    // Each stack covers the base exactly — same size, same origin — so `overlay`
    // here is a switch, not a composite. `enable` is what makes it one: outside
    // its own ranges a stack passes nothing through, and the ranges are disjoint
    // across layouts, so at most one of them is ever on. They chain, each
    // overlaying whatever the one before it produced.
    layouts.forEach((layout, li) => {
      const from = li === 0 ? "[single]" : `[ov${li - 1}]`;
      const to = li === layouts.length - 1 ? "[outv]" : `[ov${li}]`;
      parts.push(`${from}[stack${li}]overlay=0:0:enable='${enableExpr(layout.ranges)}'${to}`);
    });
  }

  if (hasAudio) parts.push(`[0:a]asetpts=PTS-STARTPTS[outa]`);
  return parts.join(";");
}


// ─── Phase 1: Detection ───────────────────────────────────────────────────────

/**
 * Run face detection on a clip segment and return crop data.
 * Caller is responsible for ensuring this does NOT run concurrently —
 * TF inference is CPU-bound and serializes internally anyway.
 */
export async function detectFacesCropData(
  inputPath: string,
  clipStart: number,
  clipEnd: number
): Promise<CropResult> {
  const ffmpeg = ffmpegBin();

  console.log(`[facetrack] Probing: ${inputPath}`);
  const { width: srcW, height: srcH, fps, duration, hasAudio } = probeVideo(inputPath);

  const start   = Math.max(0, clipStart);
  const end     = Math.min(duration, isFinite(clipEnd) ? clipEnd : duration);
  const clipDur = end - start;

  const targetAspect = OUTPUT_W / OUTPUT_H;
  const rawCropW     = Math.round(srcH * targetAspect);
  const cropW        = Math.min(rawCropW, srcW);
  const cropH        = srcH;
  const { w: DETECT_W, h: detectH } = detectSize(srcW, srcH);

  console.log(`[facetrack] ${srcW}×${srcH} ${fps.toFixed(2)}fps  clip ${start}s→${end}s  cropW=${cropW}`);

  // ── Pass 0: where, if anywhere, is this clip a group shot? ────────────────
  // Runs before BlazeFace because the answer can make BlazeFace unnecessary: a
  // clip that is a group shot END TO END uses fixed per-speaker crops, so there
  // is no camera path to build and the 4fps face pass is skipped entirely. That
  // case is cheaper than what it replaces, not dearer.
  //
  // A clip that is a group shot only in places still needs the camera for its
  // other stretches, so it runs both passes and the two plans are composited at
  // the bottom of this function.
  //
  // Failure here is never fatal. A model fetch that 500s, a TF allocation on a
  // loaded box — none of that means the clip is unusable, it just means we fall
  // back to the single-speaker camera, which is what every clip did before.
  let multiUp: MultiUpPlan | null = null;
  /** Set only when the probe could not RUN — see isProbeUnavailable. */
  let multiUpUnavailable: string | undefined;
  try {
    const { perFrame, probeFps } = await probeSpeakers(ffmpeg, inputPath, start, clipDur, srcW, srcH);
    multiUp = planMultiUp(perFrame, srcW, srcH, probeFps, clipDur);

    // ── Second pass, for clips the whole-frame probe read poorly ──
    //
    // The whole-frame pass is blind to people who are small in the frame, which
    // is every compositor layout: a screen share with the speakers in a rail
    // down one side, a webinar with a slide deck taking three quarters of the
    // picture. On the source that surfaced this it found two of five people at
    // best. One clip then fell back to the single-speaker camera, which cropped
    // a 9:16 window out of somebody else's layout, seams and name labels and
    // all; another stacked two people who were not the hosts — a pair inside the
    // video being screen-shared — for a third of its length. Slicing finds all
    // three hosts on most frames (see the table above PROBE_SLICES).
    //
    // The trigger is "no stack, or one that covers less than half the clip",
    // because both failures look the same from here: a layout that is on screen
    // throughout being seen only sometimes, or not at all. A whole-clip stack —
    // the common case, and the one that is already right — never pays for this.
    // When it does run it costs one more ffmpeg pipe and about 4x the detection
    // of a single pass, so it is worth being strict about when.
    if (!multiUp || multiUp.coverage < MULTI_UP_RESLICE_COVERAGE) {
      console.log(
        `[facetrack] Whole-frame probe gave ` +
        (multiUp ? `only ${(multiUp.coverage * 100).toFixed(0)}% coverage` : "no stack") +
        ` — re-probing in ${PROBE_SLICES} slices.`
      );
      const sliced = await probeSpeakers(ffmpeg, inputPath, start, clipDur, srcW, srcH, PROBE_SLICES);
      const slicedPlan = planMultiUp(sliced.perFrame, srcW, srcH, sliced.probeFps, clipDur);
      multiUp = betterPlan(multiUp, slicedPlan);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    if (isProbeUnavailable(err)) {
      // Not this clip's problem, and not recoverable by retrying it: the probe
      // cannot run in this process, so EVERY clip from here on is going to come
      // out single-speaker. Said at error level, and said in the words the
      // person reading the log needs, because the last time this happened it
      // read as an ordinary warning for three days.
      multiUpUnavailable = msg;
      console.error(
        `[facetrack] MULTI-UP UNAVAILABLE — the speaker probe cannot load in this ` +
        `environment, so NO clip will be stacked until it is fixed: ${msg}. ` +
        `Check that ${POSE_DETECTOR_PACKAGES.join(", ")} are all installed here.`
      );
    } else {
      console.warn(
        `[facetrack] Speaker probe failed (${msg}) — ` +
        `continuing with the single-speaker camera.`
      );
    }
  }

  if (multiUp?.whole) {
    // `whole` is only ever set on a one-layout plan — a stack that never cuts
    // away has nothing to cut to — so this path still reads the single layout.
    const only = multiUp.layouts[0];
    const grid = slotGeometry(only.slots);
    console.log(
      `[facetrack] ${only.slots} speakers on screen for the whole clip — ` +
      `stacking ${grid.cols}×${grid.rows}: ${only.boxW}×${only.boxH} at ` +
      only.crops.map((c) => `(${c.x},${c.y})`).join(" / ") + "."
    );
    return {
      srcW, srcH, fps, hasAudio,
      clipStart: start, clipEnd: end,
      cropW: only.boxW, cropH: only.boxH, rawCropW,
      isBlurBg: false,
      speakerLayout: "split",
      speakerSlots: only.slots,
      stackedRanges: [{ start: 0, end: clipDur, slots: only.slots }],
      filterComplex: multiUpFilterComplex(multiUp, hasAudio),
      // Deliberately omitted. faceFocusY answers "which slice of this clip
      // holds the face" — a question with no answer for a stack, where every
      // slice holds one.
    };
  }

  // Load BlazeFace — cached across clips
  await loadBlazeFace();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const tf = require("@tensorflow/tfjs") as typeof import("@tensorflow/tfjs");
  const model = _blazeFaceModel;

  const totalDetectFrames = Math.round(clipDur * DETECTION_FPS);
  console.log(`[facetrack] Piping ~${totalDetectFrames} detect frames at ${DETECT_W}×${detectH} @ ${DETECTION_FPS}fps (encode at ${fps.toFixed(2)}fps)…`);
  const frames = await pipeFrames(ffmpeg, inputPath, start, clipDur, DETECT_W, detectH, DETECTION_FPS);
  console.log(`[facetrack] Received ${frames.length} frames.`);

  if (frames.length === 0) throw new Error("No frames received from ffmpeg pipe");

  console.log("[facetrack] Running BlazeFace on every frame…");
  const rawCx: (number | null)[] = new Array(frames.length).fill(null);
  const faceYs: number[] = [];
  let lastCommittedCx: number | null = null;
  let detectedCount = 0;

  for (let i = 0; i < frames.length; i++) {
    const tensor = tf.tensor3d(frames[i], [detectH, DETECT_W, 3], "int32");
    const predictions = await model.estimateFaces(tensor, false);
    (tf as any).dispose(tensor);

    if (predictions.length > 0) {
      let best: (typeof predictions)[0];

      if (predictions.length === 1 || lastCommittedCx === null) {
        best = predictions.reduce((a: any, b:any) =>
          (b.probability as unknown as number[])[0] > (a.probability as unknown as number[])[0] ? b : a
        );
      } else {
        best = predictions.reduce((a:any, b:any) => {
          const aCx   = ((a.topLeft as unknown as number[])[0] + (a.bottomRight as unknown as number[])[0]) / 2 / DETECT_W;
          const bCx   = ((b.topLeft as unknown as number[])[0] + (b.bottomRight as unknown as number[])[0]) / 2 / DETECT_W;
          const aDist = Math.abs(aCx - lastCommittedCx!);
          const bDist = Math.abs(bCx - lastCommittedCx!);
          return bDist < aDist ? b : a;
        });
      }

      const relX = ((best.topLeft as unknown as number[])[0] + (best.bottomRight as unknown as number[])[0]) / 2 / DETECT_W;
      rawCx[i]          = Math.max(0, Math.min(1, relX));
      lastCommittedCx   = rawCx[i];
      detectedCount++;

      // Vertical position too. The crop never moves vertically, so this is not
      // used for cropping — it is recorded so a split-screen cutaway can show
      // the half of the clip that actually contains the face.
      const relY = ((best.topLeft as unknown as number[])[1] + (best.bottomRight as unknown as number[])[1]) / 2 / detectH;
      faceYs.push(Math.max(0, Math.min(1, relY)));
    }

    if (i % Math.max(1, Math.floor(frames.length / 20)) === 0) {
      console.log(
        `[facetrack]   ${Math.round((i / frames.length) * 100)}%  ` +
        `frame ${i}/${frames.length}  ` +
        `face=${rawCx[i] !== null ? (rawCx[i] as number).toFixed(3) : "none"}`
      );
    }
  }

  console.log(`[facetrack] Detected faces in ${detectedCount}/${frames.length} frames.`);

  // Median, not mean: a single frame that latched onto a bystander or a hand
  // would drag an average far enough to frame the split on empty background.
  const faceFocusY = (() => {
    if (faceYs.length === 0) return undefined;
    const sorted = [...faceYs].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  })();
  if (faceFocusY !== undefined) {
    console.log(`[facetrack] Face sits at y=${faceFocusY.toFixed(3)} of frame height (median of ${faceYs.length}).`);
  }

  const faceRatio = frames.length > 0 ? detectedCount / frames.length : 0;

  if (faceRatio < BLUR_BG_FACE_THRESHOLD) {
    console.log(`[facetrack] Face ratio ${(faceRatio * 100).toFixed(1)}% below threshold — using blurred background.`);
    // The stack still applies where it applies. BlazeFace finding almost no
    // faces and MoveNet finding a group shot is not a contradiction — that is the
    // exact split the two detectors showed on real material (see the table
    // above `PROBE_W`), and it would be perverse to throw away the stretch we
    // did resolve because the fallback fired for the rest.
    const filterParts = multiUp
      ? multiUpFilterComplex(multiUp, hasAudio, blurBgParts("base", "single"))
      : [...blurBgParts("0:v", "outv"), ...(hasAudio ? [`[0:a]asetpts=PTS-STARTPTS[outa]`] : [])].join(";");
    return {
      srcW, srcH, fps, hasAudio,
      clipStart: start, clipEnd: end,
      cropW, cropH, rawCropW,
      isBlurBg: true,
      filterComplex: filterParts,
      faceFocusY,
      ...multiUpFields(multiUp, multiUpUnavailable),
    };
  }

  // Detection ran at DETECTION_FPS; one sample covers fps/DETECTION_FPS encode
  // frames, and the crop expression's `n` is an encode-time frame counter. The
  // camera path is interpolated across that gap rather than held, so cropX moves
  // every frame. main-code.js detects at source fps, so its gap is 1 frame and
  // it needs no interpolation.
  const framesPerSample = fps / DETECTION_FPS;
  const centerPath = buildCommittedCenters(rawCx, DETECTION_FPS);
  const segments   = buildCropPath(centerPath, srcW, cropW, framesPerSample);
  const moves      = segments.filter((seg) => Math.round(seg.x0) !== Math.round(seg.x1)).length;
  console.log(
    `[facetrack] camera path: ${segments.length} segment(s), ${moves} pan(s), ` +
    `${segments.length - moves} hold(s) over ${centerPath.centers.length} samples`
  );

  const cropXExpr = buildCropXExpr(segments);

  return {
    srcW, srcH, fps, hasAudio,
    clipStart: start, clipEnd: end,
    cropW, cropH, rawCropW,
    isBlurBg: false,
    cropXExpr,
    // A partial group shot arrives as a full graph instead of a bare crop
    // expression, because the camera is now only one of the clip's two layouts
    // and something has to switch between them. `cropXExpr` is still returned
    // beside it so callers and logs can see the camera that graph contains.
    ...(multiUp
      ? {
          filterComplex: multiUpFilterComplex(
            multiUp,
            hasAudio,
            cameraBaseParts("base", "single", { cropW, cropH, cropXExpr, srcW, rawCropW })
          ),
        }
      : {}),
    faceFocusY,
    ...multiUpFields(multiUp, multiUpUnavailable),
  };
}

/**
 * The `speakerLayout` / `speakerSlots` / `stackedRanges` third of a CropResult.
 *
 * `speakerLayout` is written even when it is "single", and the slot count and
 * ranges are cleared with it: a re-run of a clip that no longer finds a group
 * shot has to overwrite the old answer, not leave the clip pinned to a seam
 * that is gone — or to a three-band seam when it is now a two-band stack.
 */
function multiUpFields(
  plan: MultiUpPlan | null,
  multiUpError?: string
): Pick<CropResult, "speakerLayout" | "speakerSlots" | "stackedRanges" | "multiUpError"> {
  if (!plan) return { speakerLayout: "single", speakerSlots: undefined, stackedRanges: [], multiUpError };
  // Flattened across layouts and sorted, because the composition walks them in
  // clip order and each one carries the slot count that decides where its seam
  // is. `speakerSlots` stays the dominant layout's, for consumers that read one
  // number and for rows written before a clip could change shape.
  return {
    speakerLayout: "split",
    speakerSlots: plan.slots,
    stackedRanges: takenRanges(plan.layouts),
    multiUpError,
  };
}

/**
 * Scale a crop to the output frame, padding when the source is too narrow to
 * fill 9:16. Shared so the plain `-vf` encode and the composited graph cannot
 * frame the same clip differently.
 */
function scaleAndPadChain(rawCropW: number, srcW: number): string {
  return rawCropW > srcW
    ? `scale=${OUTPUT_W}:${OUTPUT_H}:force_original_aspect_ratio=decrease:flags=lanczos,` +
      `pad=${OUTPUT_W}:${OUTPUT_H}:(ow-iw)/2:(oh-ih)/2:color=black`
    : `scale=${OUTPUT_W}:${OUTPUT_H}:flags=lanczos`;
}

/** The single-speaker camera as one filter chain, `[from]` → `[to]`. */
function cameraBaseParts(
  from: string,
  to: string,
  o: { cropW: number; cropH: number; cropXExpr: string; srcW: number; rawCropW: number }
): string[] {
  return [
    `[${from}]crop=${o.cropW}:${o.cropH}:'${o.cropXExpr}':0,` +
      `${scaleAndPadChain(o.rawCropW, o.srcW)},setsar=1[${to}]`,
  ];
}

/**
 * The blurred-background fallback as filter chains, `[from]` → `[to]`.
 *
 * No trim/atrim: encodeWithCropData input-seeks with -ss/-t, so the stream is
 * already cut to the clip window. The `setpts=PTS-STARTPTS` that used to live
 * at the head of this graph now belongs to whoever produced `[from]`.
 */
function blurBgParts(from: string, to: string): string[] {
  const head = from === "0:v" ? `[0:v]setpts=PTS-STARTPTS,split=2[bg][fg]` : `[${from}]split=2[bg][fg]`;
  return [
    head,
    `[bg]scale=${OUTPUT_W}:${OUTPUT_H}:force_original_aspect_ratio=increase,` +
      `crop=${OUTPUT_W}:${OUTPUT_H},boxblur=20:6[blurred]`,
    `[fg]scale=${OUTPUT_W}:-2:force_original_aspect_ratio=decrease[fg_scaled]`,
    // (W-w)/2, not (ow-w)/2. `ow`/`oh` belong to `pad` and `scale`; `overlay`
    // knows only W/H (the main input) and w/h (the overlaid one), so the old
    // expression made ffmpeg reject the whole graph with "Undefined constant or
    // missing '(' in 'ow-w)/2'". Every clip that reached the blurred-background
    // fallback therefore failed its encode and was rescued by the static
    // centre crop in `encodeWithFallback` — the fallback's fallback, silently,
    // on every attempt.
    `[blurred][fg_scaled]overlay=(W-w)/2:(H-h)/2,setsar=1[${to}]`,
  ];
}

// ─── Test seam ────────────────────────────────────────────────────────────────

/**
 * The pure part of the pipeline: raw per-sample face centres → ffmpeg crop
 * expression. Exported so the camera path can be exercised without BlazeFace
 * (whose weights are fetched from tfhub at load time).
 */
export function planCropXExpr(
  rawCx: (number | null)[],
  opts: { srcW: number; cropW: number; fps: number; detectionFps?: number }
): { cropXExpr: string; segments: CropSegment[] } {
  const detectionFps = opts.detectionFps ?? DETECTION_FPS;
  const centerPath = buildCommittedCenters(rawCx, detectionFps);
  const segments = buildCropPath(centerPath, opts.srcW, opts.cropW, opts.fps / detectionFps);
  return { cropXExpr: buildCropXExpr(segments), segments };
}

/**
 * A crop plan that needs no face detection: a fixed, centred 9:16 window.
 *
 * This is the safety net under face tracking. Detection is the fragile half of
 * the pipeline — it fetches model weights, pipes every sampled frame through
 * ffmpeg into TensorFlow, and holds a core for the length of the clip — while
 * encoding is just ffmpeg. When detection cannot be made to work for a clip
 * after retries, the right answer is a centre-cropped clip, not no clip: the
 * framing is worse than a tracked crop but it is a normal, downloadable short,
 * where the alternative is a red "re-crop failed · retry" card and a preview
 * that silently falls back to the uncropped 16:9 source.
 *
 * Only probes the file, so it costs milliseconds and has essentially no way to
 * fail that would not also have broken the encode.
 */
export function staticCropData(
  inputPath: string,
  clipStart: number,
  clipEnd: number
): CropResult {
  const { width: srcW, height: srcH, fps, duration, hasAudio } = probeVideo(inputPath);

  const start = Math.max(0, clipStart);
  const end = Math.min(duration, isFinite(clipEnd) ? clipEnd : duration);

  const rawCropW = Math.round(srcH * (OUTPUT_W / OUTPUT_H));
  const cropW = Math.min(rawCropW, srcW);
  const cropX = Math.max(0, Math.round((srcW - cropW) / 2));

  console.log(
    `[facetrack] Static centre crop ${srcW}×${srcH} → ${cropW}×${srcH} at x=${cropX} ` +
    `(clip ${start}s→${end}s) — no detection.`
  );

  return {
    srcW, srcH, fps, hasAudio,
    clipStart: start, clipEnd: end,
    cropW, cropH: srcH, rawCropW,
    isBlurBg: false,
    isStatic: true,
    cropXExpr: String(cropX),
    // Left undefined on purpose: nothing measured the face, and a guessed value
    // would frame a split-screen cutaway on whatever the guess happened to be.
    // The compositions already fall back to DEFAULT_FACE_FOCUS_Y.
  };
}

// ─── Phase 2: Encoding (async — safe to run multiple in parallel) ─────────────

export async function encodeWithCropData(
  inputPath: string,
  outputPath: string,
  result: CropResult
): Promise<void> {
  const ffmpeg = ffmpegBin();
  const { srcW, fps, hasAudio, clipStart, clipEnd, cropW, cropH, rawCropW } = result;

  console.log(
    `[facetrack] Encoding → ${outputPath}` +
    (result.speakerLayout === "split"
      ? ` (${result.speakerSlots ?? 2}-speaker stack)`
      : "")
  );

  // Input seek (-ss before -i) + -t so ffmpeg only decodes the clip window
  // instead of decoding the whole source and discarding the pre-clip footage
  // with a trim filter. For a clip late in a long source this is a ~3× encode
  // speedup, and it matches how detection already reads the clip (frame-accurate
  // fast seek), so crop-expression frame indices stay aligned. Clamp the seek
  // duration to be safe.
  const clipDur = Math.max(0, clipEnd - clipStart);
  const seekArgs = ["-ss", String(clipStart), "-i", inputPath, "-t", String(clipDur)];

  // Two plans arrive as a full filter graph rather than a crop expression: the
  // blurred-background fallback and the multi-speaker stack. Both terminate in
  // [outv] (+[outa]), so they encode identically from here. This used to test
  // `isBlurBg`, which silently ignored the stack's graph and re-cropped a single
  // speaker instead.
  if (result.filterComplex) {
    const graphArgs: string[] = ["-y", ...seekArgs, "-filter_complex", result.filterComplex, "-map", "[outv]"];
    if (hasAudio) graphArgs.push("-map", "[outa]", "-c:a", "aac", "-b:a", "192k");
    else graphArgs.push("-an");
    graphArgs.push(...codecArgs(fps), outputPath);

    await spawnFfmpegAsync(ffmpeg, graphArgs);
  } else {
    // No trim filter: the input is already seeked to [clipStart, clipEnd].
    const vf = [
      `setpts=PTS-STARTPTS`,
      `crop=${cropW}:${cropH}:'${result.cropXExpr}':0`,
      scaleAndPadChain(rawCropW, srcW),
    ].join(",");

    const encArgs: string[] = ["-y", ...seekArgs, "-vf", vf];
    if (hasAudio) {
      encArgs.push("-af", `asetpts=PTS-STARTPTS`, "-c:a", "aac", "-b:a", "192k");
    } else {
      encArgs.push("-an");
    }
    encArgs.push(...codecArgs(fps), outputPath);

    await spawnFfmpegAsync(ffmpeg, encArgs);
  }

  console.log(`[facetrack] Done → ${outputPath}`);
}

// ─── Resilient wrappers ──────────────────────────────────────────────────────
//
// The two phases below are what every caller should use. Face tracking has a
// long tail of transient failures — a model-weight fetch, an ffmpeg pipe that
// closes early, a TF allocation on a loaded box, an R2 PUT that 500s — and none
// of them mean the clip is unccroppable. Retry each phase, and when a phase
// genuinely cannot be made to work, degrade to a fixed centre crop rather than
// producing nothing. A slightly worse framing is a usable short; an error is
// not.

/** How many times each phase is attempted before falling back. */
const PHASE_ATTEMPTS = 3;

/**
 * Detection with retries and a guaranteed result.
 *
 * `tracked: false` means detection never succeeded and the returned plan is the
 * static centre crop — the clip is still fully renderable, it just is not
 * following the speaker. Throws only when even `ffprobe` cannot read the file,
 * which is a real, permanent problem with the source rather than a flake.
 */
export async function detectCropDataResilient(
  inputPath: string,
  clipStart: number,
  clipEnd: number,
  label = "clip"
): Promise<{ result: CropResult; tracked: boolean }> {
  const { tryWithRetry } = await import("./retry.ts");

  const result = await tryWithRetry(
    () => detectFacesCropData(inputPath, clipStart, clipEnd),
    { attempts: PHASE_ATTEMPTS, baseDelayMs: 2_000, label: `facetrack detect ${label}` }
  );
  if (result) return { result, tracked: true };

  console.warn(`[facetrack] ${label}: detection failed — falling back to a centre crop.`);
  return { result: staticCropData(inputPath, clipStart, clipEnd), tracked: false };
}

/**
 * Encode with retries, then with a static centre crop if the tracked plan is
 * what ffmpeg is choking on (a malformed crop expression from a pathological
 * camera path would fail identically every attempt, so re-running the same plan
 * forever is not the fix).
 *
 * Throws only when the fallback encode also fails after its own retries.
 */
export async function encodeWithFallback(
  inputPath: string,
  outputPath: string,
  result: CropResult,
  label = "clip"
): Promise<SpeakerLayoutResult & { tracked: boolean }> {
  const { tryWithRetry, withRetry } = await import("./retry.ts");

  // A plan that outgrew its memory budget grows the same way on every attempt
  // — the kernel log showed exactly that, one command killed at ~1.6 GB every
  // ~40 s. Retrying it only spends two more minutes at the edge of the
  // container limit; the centre crop below is the change of plan it needs.
  const notBudget = (err: unknown) => !(err instanceof MemoryBudgetError);
  const ok = await tryWithRetry(
    () => encodeWithCropData(inputPath, outputPath, result),
    { attempts: PHASE_ATTEMPTS, baseDelayMs: 1_500, label: `facetrack encode ${label}`, shouldRetry: notBudget }
  );
  // The layout comes from what was ENCODED, never from what was planned: the
  // fallback below writes a single-speaker centre crop, and a clip stored as
  // "split" would move its captions to the seam of a stack that is not there.
  if (ok !== null) {
    return {
      tracked: result.isStatic !== true,
      speakerLayout: result.speakerLayout ?? "single",
      speakerSlots: result.speakerLayout === "split" ? result.speakerSlots ?? 2 : undefined,
      stackedRanges: result.speakerLayout === "split" ? result.stackedRanges ?? [] : [],
      multiUpError: result.multiUpError,
    };
  }

  console.warn(`[facetrack] ${label}: encode failed — retrying with a centre crop.`);
  const fallback = staticCropData(inputPath, result.clipStart, result.clipEnd);
  await withRetry(
    () => encodeWithCropData(inputPath, outputPath, fallback),
    { attempts: PHASE_ATTEMPTS, baseDelayMs: 1_500, label: `facetrack encode-fallback ${label}`, shouldRetry: notBudget }
  );
  return {
    tracked: false,
    speakerLayout: "single",
    speakerSlots: undefined,
    stackedRanges: [],
    multiUpError: result.multiUpError,
  };
}

/**
 * What the caller has to persist about a clip's layout. One type because these
 * three always travel together — a "split" flag without its slot count sends
 * the captions to the wrong seam, and without its ranges to the wrong frames.
 */
export interface SpeakerLayoutResult {
  speakerLayout: "single" | "split";
  /** 2, 3 or 4 on a "split" clip; undefined on a "single" one. */
  speakerSlots?: number;
  stackedRanges: TimeRange[];
  /**
   * Set only when the speaker probe could not RUN — see `CropResult.multiUpError`.
   * A "single" clip with this set is not a clip with one speaker in it; it is a
   * clip nobody looked at.
   */
  multiUpError?: string;
}

// ─── Combined single-clip API (wraps detect + encode) ────────────────────────

export async function cropVideoSegment(
  inputPath: string,
  outputPath: string,
  clipStart: number,
  clipEnd: number,
  label = "clip"
): Promise<SpeakerLayoutResult & { faceFocusY?: number; tracked: boolean }> {
  const { result } = await detectCropDataResilient(inputPath, clipStart, clipEnd, label);
  const { tracked, speakerLayout, speakerSlots, stackedRanges, multiUpError } =
    await encodeWithFallback(inputPath, outputPath, result, label);
  // faceFocusY survives an encode fallback: the crop is horizontal-only in both
  // the tracked and the static plan (cropH is always the full source height), so
  // a vertical position measured during detection is still where the face is in
  // the output. It is undefined precisely when detection never measured it.
  return { faceFocusY: result.faceFocusY, tracked, speakerLayout, speakerSlots, stackedRanges, multiUpError };
}

/**
 * Stream a source video to `dest`, replacing whatever was there.
 *
 * Uses a presigned S3 URL rather than the public CDN domain: the CDN's WAF
 * answers 403 to datacenter IPs, which is a permanent failure that looks
 * exactly like a transient one.
 */
export async function downloadSourceTo(dest: string, videoUrl: string): Promise<void> {
  const { toDownloadableUrl } = await import("./r2.ts");
  console.log(`[facetrack] Downloading source video…`);
  try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch {}

  const res = await fetch(await toDownloadableUrl(videoUrl), { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`Failed to fetch video (${res.status})`);

  const fileStream = fs.createWriteStream(dest);
  const reader = res.body!.getReader();
  await new Promise<void>((resolve, reject) => {
    const pump = () => reader.read().then(({ done, value }) => {
      if (done) { fileStream.end(); return; }
      fileStream.write(value, (err) => { if (err) { reject(err); return; } pump(); });
    }).catch(reject);
    fileStream.on("finish", resolve);
    fileStream.on("error", reject);
    pump();
  });

  const size = fs.statSync(dest).size;
  if (size === 0) throw new Error("Downloaded source is empty");
  console.log(`[facetrack] Downloaded ${(size / 1024 / 1024).toFixed(1)} MB`);
}

// ─── Public batch API ─────────────────────────────────────────────────────────

/**
 * Download a video, crop a segment with face tracking, upload the result to R2.
 *
 * Returns the uploaded URL plus the measured vertical face position, which the
 * caller must persist: it is what keeps the speaker's face in frame when a
 * split-screen B-roll cutaway reduces them to half the height.
 *
 * Pass `localVideoPath` to skip the download (when caller already has the file).
 */
export async function cropShortWithFaceTracking(
  videoUrl: string,
  startTime: number,
  endTime: number,
  outputR2Key: string,
  localVideoPath?: string
): Promise<SpeakerLayoutResult & { url: string; faceFocusY?: number; tracked: boolean }> {
  const { uploadFileToR2 } = await import("./r2.ts");
  const { withRetry } = await import("./retry.ts");

  const tmpDir     = "/tmp";
  const ownedInput = !localVideoPath;
  const inputPath  = localVideoPath ?? path.join(tmpDir, `facetrack-input-${Date.now()}.mp4`);
  const outputPath = path.join(tmpDir, `facetrack-output-${Date.now()}.mp4`);
  const label      = outputR2Key;

  try {
    if (ownedInput) {
      // Retried as a unit: a truncated download leaves a file that probes fine
      // and then fails mid-encode, so each attempt starts the file over rather
      // than resuming into a half-written one.
      await withRetry(
        () => downloadSourceTo(inputPath, videoUrl),
        { attempts: 3, baseDelayMs: 3_000, label: `facetrack download ${label}` }
      );
    }

    const { faceFocusY, tracked, speakerLayout, speakerSlots, stackedRanges, multiUpError } =
      await cropVideoSegment(inputPath, outputPath, startTime, endTime, label);

    // Streamed from disk rather than read into a Buffer: an encoded clip is
    // tens of megabytes, and holding that in the heap alongside TensorFlow on a
    // small box is how this process gets OOM-killed mid-request.
    const r2Url = await withRetry(
      () => uploadFileToR2(outputPath, outputR2Key, "video/mp4"),
      { attempts: 3, baseDelayMs: 2_000, label: `facetrack upload ${label}` }
    );
    console.log(`[facetrack] Uploaded cropped clip to R2: ${r2Url}${tracked ? "" : " (centre crop — detection unavailable)"}`);
    return { url: r2Url, faceFocusY, tracked, speakerLayout, speakerSlots, stackedRanges, multiUpError };
  } finally {
    if (ownedInput) {
      try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch {}
    }
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch {}
  }
}
