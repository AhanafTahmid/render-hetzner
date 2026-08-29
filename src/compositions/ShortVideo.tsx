/**
 * GENERATED — do not edit.
 *
 * Written by shortshero/scripts/sync-render-composition.mjs from
 * components/RemotionShortPlayer.tsx, the editor preview. Editing this file by
 * hand is how the export drifted away from the preview in the first place.
 *
 * To change what the export renders, change the preview and re-run:
 *   pnpm sync:render      (then rebuild and redeploy the render server)
 */
import React from "react";
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { splitBox, mainBox, activeSplitAt, mainObjectPosition } from "../shorts/splitLayout";
import { captionGroupStyle, captionWordStyle, type CaptionRenderStyle } from "../shorts/captionRender";
// Every caption typeface a preset can name. The container installs no system
// fonts, so without this every preset renders in the same fallback face.
import "../captionFonts";

export interface CaptionStyle extends CaptionRenderStyle {
  positionBottom?: number;
  wordsPerBatch?: number;
  layout?: "inline" | "stacked";
  showEmojis?: boolean;
  disabled?: boolean;
}

// ── Watermark overlay (shown for free users) ──────────────────────────────────
type WatermarkPosition = "top-right" | "top-left" | "bottom-right" | "bottom-left" | "top-center";

const WATERMARK_POSITIONS: WatermarkPosition[] = [
  "top-right", "bottom-left", "top-left", "bottom-right", "top-center",
];

function getWatermarkStyle(pos: WatermarkPosition): React.CSSProperties {
  const base: React.CSSProperties = { position: "absolute", pointerEvents: "none", display: "flex", alignItems: "center" };
  switch (pos) {
    case "top-right":    return { ...base, top: 40, right: 24 };
    case "top-left":     return { ...base, top: 40, left: 24 };
    case "bottom-right": return { ...base, bottom: 180, right: 24 };
    case "bottom-left":  return { ...base, bottom: 180, left: 24 };
    case "top-center":   return { ...base, top: 40, left: "50%", transform: "translateX(-50%)" };
    default:             return { ...base, top: 40, right: 24 };
  }
}

function WatermarkOverlay({ frame, totalFrames, fps }: { frame: number; totalFrames: number; fps: number }) {
  const segDur = 3 * fps;
  const posIdx = Math.floor(frame / segDur) % WATERMARK_POSITIONS.length;
  const pos = WATERMARK_POSITIONS[posIdx];
  const frameInSeg = frame % segDur;
  const fadeDur = Math.round(fps * 0.3);
  let opacity = 0.55;
  if (frameInSeg < fadeDur) {
    opacity = interpolate(frameInSeg, [0, fadeDur], [0.2, 0.55], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  } else if (frameInSeg > segDur - fadeDur) {
    opacity = interpolate(frameInSeg, [segDur - fadeDur, segDur], [0.55, 0.2], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  }
  return (
    <div style={getWatermarkStyle(pos)}>
      <span style={{
        color: `rgba(255,255,255,${opacity})`,
        fontSize: 28,
        fontWeight: 700,
        fontFamily: "system-ui, -apple-system, sans-serif",
        letterSpacing: 1,
        textShadow: "0 2px 8px rgba(0,0,0,0.7), 0 0 20px rgba(0,0,0,0.5)",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}>
        shortshero.com
      </span>
    </div>
  );
}

/**
 * Fallback for a short whose stored captionStyle is empty or unparseable.
 * Mirrors DEFAULT_CAPTION_STYLE in lib/captionPresets.ts and the copy in
 * render/src/compositions/ShortVideo.tsx. All three used to disagree — this one
 * and the render's said black-on-yellow uppercase 900, the app's said
 * white-on-transparent 700 — so a short with no stored style looked nothing like
 * one saved with the "default" preset.
 */
const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontSize: 84,
  color: "#FFFFFF",
  backgroundColor: "#000000",
  bgOpacity: 0,
  inactiveColor: "rgba(255,255,255,0.62)",
  inactiveBackgroundColor: "transparent",
  fontFamily: `"Inter", system-ui, -apple-system, sans-serif`,
  fontWeight: "900",
  textTransform: "none",
  outlineColor: "#000000",
  outlineWidth: 7,
  textShadow: "0 6px 18px rgba(0,0,0,0.45)",
  highlight: "color",
  activeScale: 1.12,
  letterSpacing: 0,
  borderRadius: 16,
  padding: "10px 22px",
  positionBottom: 18,
  wordsPerBatch: 3,
  layout: "inline",
};

// ── Extra track clip renderer ─────────────────────────────────────────────────
function ExtraClipLayer({ clip }: { clip: any }) {
  const frame = useCurrentFrame();
  const N = Math.max(1, clip.durationFrames ?? 30);
  const effect = clip.effect || "none";
  const speed = Math.max(0.1, clip.effectSpeed ?? 1);
  const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };

  // Apply speed by compressing the animation range — higher speed = completes sooner
  const EN = Math.max(1, N / speed);           // effective end for continuous effects
  const SLIDE_N = Math.max(1, (N * 0.6) / speed); // effective end for slide-in effects

  // Build CSS transform from effect id (matches ImageEffectsPanel EFFECTS ids)
  let transform = "";
  switch (effect) {
    case "zoom-in": {
      const s = interpolate(frame, [0, EN], [1, 1.2], clamp);
      transform = `scale(${s})`;
      break;
    }
    case "zoom-out": {
      const s = interpolate(frame, [0, EN], [1.2, 1], clamp);
      transform = `scale(${s})`;
      break;
    }
    case "scroll-left": {
      const tx = interpolate(frame, [0, EN], [5, -5], clamp);
      transform = `scale(1.1) translateX(${tx}%)`;
      break;
    }
    case "scroll-right": {
      const tx = interpolate(frame, [0, EN], [-5, 5], clamp);
      transform = `scale(1.1) translateX(${tx}%)`;
      break;
    }
    case "scroll-up": {
      const ty = interpolate(frame, [0, EN], [5, -5], clamp);
      transform = `scale(1.1) translateY(${ty}%)`;
      break;
    }
    case "scroll-down": {
      const ty = interpolate(frame, [0, EN], [-5, 5], clamp);
      transform = `scale(1.1) translateY(${ty}%)`;
      break;
    }
    case "ken-burns-up": {
      const s = interpolate(frame, [0, EN], [1, 1.08], clamp);
      const ty = interpolate(frame, [0, EN], [0, -3], clamp);
      transform = `scale(${s}) translateY(${ty}%)`;
      break;
    }
    case "ken-burns-down": {
      const s = interpolate(frame, [0, EN], [1, 1.08], clamp);
      const ty = interpolate(frame, [0, EN], [0, 3], clamp);
      transform = `scale(${s}) translateY(${ty}%)`;
      break;
    }
    case "diagonal-up-left": {
      const tx = interpolate(frame, [0, EN], [2, -2], clamp);
      const ty = interpolate(frame, [0, EN], [2, -2], clamp);
      transform = `scale(1.1) translate(${tx}%, ${ty}%)`;
      break;
    }
    case "diagonal-up-right": {
      const tx = interpolate(frame, [0, EN], [-2, 2], clamp);
      const ty = interpolate(frame, [0, EN], [2, -2], clamp);
      transform = `scale(1.1) translate(${tx}%, ${ty}%)`;
      break;
    }
    case "diagonal-down-left": {
      const tx = interpolate(frame, [0, EN], [2, -2], clamp);
      const ty = interpolate(frame, [0, EN], [-2, 2], clamp);
      transform = `scale(1.1) translate(${tx}%, ${ty}%)`;
      break;
    }
    case "diagonal-down-right": {
      const tx = interpolate(frame, [0, EN], [-2, 2], clamp);
      const ty = interpolate(frame, [0, EN], [-2, 2], clamp);
      transform = `scale(1.1) translate(${tx}%, ${ty}%)`;
      break;
    }
    case "slide-in-left": {
      const tx = interpolate(frame, [0, SLIDE_N], [-100, 0], clamp);
      transform = `translateX(${tx}%)`;
      break;
    }
    case "slide-in-right": {
      const tx = interpolate(frame, [0, SLIDE_N], [100, 0], clamp);
      transform = `translateX(${tx}%)`;
      break;
    }
    case "slide-in-top": {
      const ty = interpolate(frame, [0, SLIDE_N], [-100, 0], clamp);
      transform = `translateY(${ty}%)`;
      break;
    }
    case "slide-in-bottom": {
      const ty = interpolate(frame, [0, SLIDE_N], [100, 0], clamp);
      transform = `translateY(${ty}%)`;
      break;
    }
    default:
      break;
  }

  // Overlay position/scale: posX/posY are % offsets from center, overlayScale is 0..2 (default 1 = full screen)
  const overlayScale: number = clip.overlayScale ?? 1;
  const posX: number = clip.overlayX ?? 0;
  const posY: number = clip.overlayY ?? 0;

  // A split cutaway owns half the frame outright — overlayScale/X/Y describe a
  // centred picture-in-picture box and cannot express "full width, half height,
  // anchored to one edge", so the split case bypasses them entirely.
  const isSplit = clip.split === "top" || clip.split === "bottom";

  const containerStyle: React.CSSProperties = isSplit
    ? splitBox(clip.split)
    : overlayScale < 0.999
    ? {
        position: "absolute",
        width: `${overlayScale * 100}%`,
        height: `${overlayScale * 100}%`,
        top: "50%",
        left: "50%",
        transform: `translate(calc(-50% + ${posX}%), calc(-50% + ${posY}%))`,
        overflow: "hidden",
      }
    : { position: "absolute", inset: 0, overflow: "hidden" };

  const mediaStyle: React.CSSProperties = {
    width: "100%", height: "100%", objectFit: "cover", display: "block",
    transform, transformOrigin: "center center",
  };

  if (!clip.url?.startsWith("http")) return null;

  if (clip.type === "video") {
    return (
      <div style={containerStyle}>
        {/* startFrom is where the clip begins inside its own file — set by a
            left-edge trim or a split. Without it both halves of a split clip
            replayed the same opening seconds. */}
        {/* muted: B-roll is a picture, never a voice. Stock footage carries its
            own audio — traffic, music, a narrator — and Remotion mixes every
            unmuted video in the composition, so an overlay clip talked over the
            speaker for as long as it was on screen. The main video below is the
            only track that keeps its sound. */}
        <OffthreadVideo
          src={clip.url}
          startFrom={Math.max(0, Math.round(clip.sourceStartFrame ?? 0))}
          muted style={{ ...mediaStyle, position: "absolute", inset: 0 }}
        />
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <Img src={clip.url} style={mediaStyle} />
    </div>
  );
}

export const ShortComposition = ({
  videoUrl,
  croppedVideoUrl,
  startTime,
  endTime,
  captions,
  captionStyle = DEFAULT_CAPTION_STYLE,
  showWatermark = false,
  extraTracks,
  faceFocusY,
  speakerLayout,
  stackedRanges,
  mainSegments,
  hideMainVideo,
}: any) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();

  // Ensure numeric types (Lambda passes them as strings sometimes)
  const st = Number(startTime ?? 0);
  const et = Number(endTime ?? 4);
  const durationInFrames = Math.max(1, Math.ceil((et - st) * fps));

  // Accept both remote URLs and locally prefetched blob: URLs
  const isPlayable = (u?: string) => !!u && (u.startsWith("http") || u.startsWith("blob:"));
  // An empty src renders the black fill below, which is what the Video track eye
  // means. It used to be expressed in the preview by withholding croppedVideoUrl,
  // which fell through to the RAW source instead of hiding anything — so the
  // preview showed an uncropped speaker and the export showed a cropped one.
  const src = hideMainVideo
    ? ""
    : (isPlayable(croppedVideoUrl) ? croppedVideoUrl : null) || (isPlayable(videoUrl) ? videoUrl : null) || "";
  // Only the face-tracked clip is 9:16 like the composition, so only it gets
  // cropped vertically by a half-height box. The raw source is landscape: it
  // fills a half-height box edge to edge and loses width, not height.
  const usesPortraitSource = isPlayable(croppedVideoUrl);
  const fromFrame = isPlayable(croppedVideoUrl) ? 0 : Math.floor(st * fps);
  const currentTime = st + frame / fps;

  /**
   * The main track as a list of pieces, in clip-relative seconds.
   *
   * One entry until the clip is split. Each piece names where it starts INSIDE
   * the short and how long it runs, so a split produces two pieces that resume
   * one another instead of two copies of the same opening — the same idea as
   * `sourceStartFrame` on an overlay clip.
   *
   * Clip-relative rather than source-absolute on purpose: the face-tracked clip
   * (`croppedVideoUrl`) is already trimmed and starts at 0, while the raw source
   * starts at `startTime`. `fromFrame` below already carries that difference, so
   * offsets measured from the start of the short work for both.
   */
  const segments: { start: number; duration: number }[] = (() => {
    const raw: unknown = typeof mainSegments === "string"
      ? (() => { try { return JSON.parse(mainSegments); } catch { return null; } })()
      : mainSegments;
    const list = Array.isArray(raw)
      ? (raw as Array<Record<string, unknown>>)
          .map((sg) => ({ start: Number(sg?.start) || 0, duration: Number(sg?.duration) }))
          .filter((sg) => sg.duration > 0)
      : [];
    return list.length ? list : [{ start: 0, duration: et - st }];
  })();

  /**
   * Each piece's slot on the timeline and its window inside the source.
   *
   * `clipFrom` is the piece's start measured from the head of the UNCUT clip,
   * which `segFrom` is not: `segFrom` carries `fromFrame` so it can address the
   * raw source as well as the pre-trimmed face-tracked file. Anything that has
   * to turn a TIMELINE frame back into a CLIP timestamp needs the former — cut
   * a chunk out of the middle of a short and the two stop agreeing.
   */
  const placedSegments = segments.reduce<{ from: number; durF: number; segFrom: number; clipFrom: number }[]>(
    (acc, seg) => {
      const durF = Math.max(1, Math.round(seg.duration * fps));
      const prev = acc[acc.length - 1];
      acc.push({
        from: prev ? prev.from + prev.durF : 0,
        durF,
        segFrom: fromFrame + Math.round(seg.start * fps),
        clipFrom: Math.round(seg.start * fps),
      });
      return acc;
    },
    []
  );

  const style = { ...DEFAULT_CAPTION_STYLE, ...captionStyle };
  const batchSize = (style as CaptionStyle).wordsPerBatch || 3;

  let activeGroup: { words: any[]; start: number; end: number } | null = null;
  if (captions) {
    let parsedCaptions = captions;
    if (typeof captions === "string") {
      try { parsedCaptions = JSON.parse(captions); } catch { parsedCaptions = []; }
    }
    // Captions store absolute timestamps from processVideo; currentTime = st + frame/fps
    // is also absolute, so no normalization needed regardless of croppedVideoUrl.
    const normalizedCaptions = parsedCaptions;
    const groups: { words: any[]; start: number; end: number }[] = [];
    for (let i = 0; i < normalizedCaptions.length; i += batchSize) {
      const chunk = normalizedCaptions.slice(i, i + batchSize);
      if (!chunk[0]) continue;
      groups.push({ words: chunk, start: chunk[0].start, end: chunk[chunk.length - 1].end });
    }
    activeGroup = groups.find((g) => currentTime >= g.start && currentTime <= g.end) || null;
  }

  // Parse extra tracks (may arrive as JSON string from Lambda inputProps)
  const parsedExtraTracks: any[] = (() => {
    if (!extraTracks) return [];
    if (typeof extraTracks === "string") {
      try { return JSON.parse(extraTracks); } catch { return []; }
    }
    return Array.isArray(extraTracks) ? extraTracks : [];
  })();

  // Which half of the frame the speaker keeps, this frame. Recomputed per frame
  // because a cutaway covers only part of the clip.
  const activeSplit = activeSplitAt(parsedExtraTracks, frame);

  // Where this timeline frame sits inside the UNCUT clip. The two are the same
  // number until the short is cut in the editor, at which point the timeline is
  // shorter than the clip and everything measured in clip seconds — the stacked
  // ranges below — has to be looked up through the cut, not past it.
  const clipTime = clipTimeAt(placedSegments, frame, fps);

  // A two-speaker clip arrives already stacked — face tracking encoded the two
  // crops into the file, so there is nothing for this composition to lay out.
  // What it does owe the clip is the caption position: the seam at 50% is the
  // one band that covers neither face, and it is where a split cutaway already
  // puts them, so the two cases look the same.
  //
  // Per frame, because the stack is per SEGMENT. A podcast master cuts between
  // a wide two-shot and single close-ups, so face tracking stacks the stretches
  // that hold both speakers and runs its single-speaker camera over the rest —
  // and `stackedRanges` says which frames are which. Pinning the captions to
  // the seam for the whole clip parks them across the face of every close-up in
  // it, which is exactly what a two-speaker clip looked like before this.
  //
  // `stackedRanges` is the ONLY thing that raises the captions; `speakerLayout`
  // just confirms the clip is the kind that can have them. A clip with no
  // ranges gets ordinary bottom captions — see `withinRanges` for why the
  // unknown case resolves that way rather than the other.
  const stackedSpeakers = speakerLayout === "split" && withinRanges(stackedRanges, clipTime);

  return (
    <AbsoluteFill className="bg-black">
      {/* Main video — one Sequence per piece. Unsplit, that is a single piece
          spanning the whole short, i.e. exactly what this used to render. */}
      {placedSegments.map(({ from, durF, segFrom }, i) => {
          return (
            <Sequence key={`main-${i}`} from={from} durationInFrames={durF}>
              {/* Shrinks to half the frame while a split cutaway is on screen, so
                  the speaker and the B-roll each get full width at half height. */}
              <div style={mainBox(activeSplit)}>
                {src ? (
                  <OffthreadVideo
                    src={src}
                    startFrom={segFrom}
                    endAt={Math.max(segFrom + 1, segFrom + durF)}                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                      // Aim the half-height window at the face; a no-op when no
                      // cutaway is on screen.
                      objectPosition: mainObjectPosition(activeSplit, faceFocusY, usesPortraitSource),
                    }}
                  />
                ) : (
                  <AbsoluteFill style={{ backgroundColor: "#000" }} />
                )}
              </div>
            </Sequence>
          );
      })}

      {/* Extra tracks rendered on top of base video (reversed so track[0] is topmost) */}
      {[...parsedExtraTracks].reverse().map((track: any) =>
        track.visible !== false && Array.isArray(track.clips)
          ? track.clips.map((clip: any) => (
              <Sequence key={clip.id} from={clip.startFrame ?? 0} durationInFrames={Math.max(1, clip.durationFrames ?? 30)}>
                <ExtraClipLayer clip={clip} />
              </Sequence>
            ))
          : null
      )}

      {/* Captions */}
      {activeGroup && !(style as CaptionStyle).disabled && (
        <AbsoluteFill>
          {/* Styling lives in lib/captionRender.ts, shared verbatim with the
              render server, so this preview cannot drift from the export.
              While a cutaway is up the captions move to the split seam — at the
              normal bottom position they sit on top of the stock footage. */}
          <div style={captionGroupStyle(style, activeSplit !== null || stackedSpeakers)}>
            {activeGroup.words.map((w: any, i: number) => (
              <span key={i} style={captionWordStyle(style, currentTime >= w.start && currentTime <= w.end)}>
                {w.text || w.punctuated_word || w.word}
              </span>
            ))}
          </div>
        </AbsoluteFill>
      )}

      {/* Watermark for free users */}
      {showWatermark && (
        <WatermarkOverlay frame={frame} totalFrames={durationInFrames} fps={fps} />
      )}
    </AbsoluteFill>
  );
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Turn a timeline frame into a timestamp inside the uncut clip.
 *
 * Identity for a short that has not been cut. For one that has, the piece
 * holding `frame` says where in the clip it came from, and the offset within
 * that piece carries over unchanged — the same mapping `segFrom` performs for
 * the video itself, so the picture and anything keyed to clip time agree.
 */
function clipTimeAt(
  placed: { from: number; durF: number; clipFrom: number }[],
  frame: number,
  fps: number
): number {
  for (const p of placed) {
    if (frame < p.from + p.durF) return (p.clipFrom + Math.max(0, frame - p.from)) / fps;
  }
  const last = placed[placed.length - 1];
  return last ? (last.clipFrom + last.durF) / fps : frame / fps;
}

/**
 * Is `t` (seconds into the uncut clip) inside any of `ranges`?
 *
 * An absent or empty list means NOWHERE, not "the whole clip". That default was
 * the other way round at first, on the reasoning that a "split" short written
 * before the stack became per-segment was stacked end to end — true, but it
 * makes the unknown case fail in the expensive direction, and the two
 * directions are not equally expensive:
 *
 *   - Captions at the seam on an UNSTACKED frame sit across the speaker's face.
 *     Broken, and the bug this whole path exists to fix.
 *   - Captions at their normal height on a STACKED frame sit at 82% of the
 *     frame, while the lower speaker's face is at ~70% — on their chest, which
 *     is exactly where captions sit on every ordinary clip. Fine.
 *
 * So when nothing tells us where the stack is, put the captions where they are
 * never wrong. A clip that carries ranges still gets the seam for precisely the
 * frames that are stacked.
 */
function withinRanges(
  ranges: { start: number; end: number }[] | undefined | null,
  t: number
): boolean {
  if (!Array.isArray(ranges) || ranges.length === 0) return false;
  return ranges.some((r) => t >= Number(r?.start) && t <= Number(r?.end));
}
