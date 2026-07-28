"use client";

import React, { useEffect, useMemo } from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  interpolate,
  OffthreadVideo,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { TimelineItem } from "../buildTimeline";
import { buildTimeline, timelineDurationFrames } from "../buildTimeline";

const TRANSITION_FRAMES = 10; // ~0.33s crossfade at 30fps
const SLIDE_FRAMES = 20; // ~0.67s for slide-in transition
// Extra frames held after audio ends so the crossfade begins only after the speaker finishes
const CLIP_PADDING_FRAMES = TRANSITION_FRAMES;

function isVideoLikeUrl(url: string): boolean {
  return (
    url.includes(".mp4") ||
    url.includes(".webm") ||
    url.includes(".mov") ||
    url.includes(".avi") ||
    url.includes(".m4v") ||
    url.includes(".mkv") ||
    url.includes("vimeo.com/external") ||
    url.includes("videos.pexels.com") ||
    url.includes("/video/upload/") ||
    // S3 animated clips (may have been uploaded without a file extension)
    url.includes("/anim_")
  );
}

// Watermark positions that cycle throughout the video
type WatermarkPosition = "top-right" | "top-left" | "bottom-right" | "bottom-left" | "center" | "top-center" | "bottom-center";

const WATERMARK_POSITIONS: WatermarkPosition[] = [
  "top-right",
  "bottom-left", 
  "top-left",
  "bottom-right",
  "center",
  "top-center",
  "bottom-center",
];

function getWatermarkStyle(position: WatermarkPosition): React.CSSProperties {
  const base: React.CSSProperties = {
    position: "absolute",
    pointerEvents: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  switch (position) {
    case "top-right":
      return { ...base, top: 40, right: 24 };
    case "top-left":
      return { ...base, top: 40, left: 24 };
    case "bottom-right":
      return { ...base, bottom: 180, right: 24 }; // Above captions
    case "bottom-left":
      return { ...base, bottom: 180, left: 24 }; // Above captions
    case "center":
      return { ...base, top: "45%", left: "50%", transform: "translate(-50%, -50%)" };
    case "top-center":
      return { ...base, top: 40, left: "50%", transform: "translateX(-50%)" };
    case "bottom-center":
      return { ...base, bottom: 180, left: "50%", transform: "translateX(-50%)" }; // Above captions
    default:
      return { ...base, top: 40, right: 24 };
  }
}

interface WatermarkOverlayProps {
  frame: number;
  totalFrames: number;
  fps: number;
}

function WatermarkOverlay({ frame, totalFrames, fps }: WatermarkOverlayProps) {
  // Change position every 3 seconds (or divide video into segments)
  const positionChangeDuration = 3 * fps; // 3 seconds in frames
  const positionIndex = Math.floor(frame / positionChangeDuration) % WATERMARK_POSITIONS.length;
  const position = WATERMARK_POSITIONS[positionIndex];
  
  // Calculate opacity for smooth transition between positions
  const frameInSegment = frame % positionChangeDuration;
  const transitionDuration = Math.round(fps * 0.3); // 0.3s transition
  
  let opacity = 0.55;
  if (frameInSegment < transitionDuration) {
    // Fading in
    opacity = interpolate(frameInSegment, [0, transitionDuration], [0.2, 0.55], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  } else if (frameInSegment > positionChangeDuration - transitionDuration) {
    // Fading out before position change
    opacity = interpolate(
      frameInSegment,
      [positionChangeDuration - transitionDuration, positionChangeDuration],
      [0.55, 0.2],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
    );
  }

  const positionStyle = getWatermarkStyle(position);
  const isCenter = position === "center";

  return (
    <div style={positionStyle}>
      <span
        style={{
          color: `rgba(255,255,255,${opacity})`,
          fontSize: isCenter ? 42 : 28,
          fontWeight: 700,
          fontFamily: "system-ui, -apple-system, sans-serif",
          letterSpacing: isCenter ? 2 : 1,
          textShadow: "0 2px 8px rgba(0,0,0,0.7), 0 0 20px rgba(0,0,0,0.5)",
          userSelect: "none",
          whiteSpace: "nowrap",
        }}
      >
        vidshero.com
      </span>
    </div>
  );
}

function computeEffectTransforms(
  effect: string | undefined,
  frame: number,
  startFrame: number,
  endFrame: number,
  clipIndex: number
): { imgTransform: string; wrapperTransform?: string } {
  const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };

  if (effect === undefined) {
    // Default alternating ken burns (original behavior)
    const scale = interpolate(frame, [startFrame, endFrame], clipIndex % 2 === 0 ? [1.0, 1.08] : [1.08, 1.0], clamp);
    const tx = interpolate(
      frame, [startFrame, endFrame],
      clipIndex % 4 === 0 ? [0, -2] : clipIndex % 4 === 1 ? [0, 2] : clipIndex % 4 === 2 ? [-2, 0] : [2, 0],
      clamp
    );
    return { imgTransform: `scale(${scale}) translateX(${tx}%)` };
  }

  switch (effect) {
    case "none":
      return { imgTransform: "none" };
    case "scroll-up": {
      const ty = interpolate(frame, [startFrame, endFrame], [0, -5], clamp);
      return { imgTransform: `scale(1.1) translateY(${ty}%)` };
    }
    case "scroll-down": {
      const ty = interpolate(frame, [startFrame, endFrame], [0, 5], clamp);
      return { imgTransform: `scale(1.1) translateY(${ty}%)` };
    }
    case "scroll-left": {
      const tx = interpolate(frame, [startFrame, endFrame], [0, -5], clamp);
      return { imgTransform: `scale(1.1) translateX(${tx}%)` };
    }
    case "scroll-right": {
      const tx = interpolate(frame, [startFrame, endFrame], [0, 5], clamp);
      return { imgTransform: `scale(1.1) translateX(${tx}%)` };
    }
    case "zoom-in": {
      const s = interpolate(frame, [startFrame, endFrame], [1.0, 1.15], clamp);
      return { imgTransform: `scale(${s})` };
    }
    case "zoom-out": {
      const s = interpolate(frame, [startFrame, endFrame], [1.15, 1.0], clamp);
      return { imgTransform: `scale(${s})` };
    }
    case "diagonal-up-left": {
      const tx = interpolate(frame, [startFrame, endFrame], [2, -2], clamp);
      const ty = interpolate(frame, [startFrame, endFrame], [2, -2], clamp);
      return { imgTransform: `scale(1.1) translate(${tx}%, ${ty}%)` };
    }
    case "diagonal-up-right": {
      const tx = interpolate(frame, [startFrame, endFrame], [-2, 2], clamp);
      const ty = interpolate(frame, [startFrame, endFrame], [2, -2], clamp);
      return { imgTransform: `scale(1.1) translate(${tx}%, ${ty}%)` };
    }
    case "diagonal-down-left": {
      const tx = interpolate(frame, [startFrame, endFrame], [2, -2], clamp);
      const ty = interpolate(frame, [startFrame, endFrame], [-2, 2], clamp);
      return { imgTransform: `scale(1.1) translate(${tx}%, ${ty}%)` };
    }
    case "diagonal-down-right": {
      const tx = interpolate(frame, [startFrame, endFrame], [-2, 2], clamp);
      const ty = interpolate(frame, [startFrame, endFrame], [-2, 2], clamp);
      return { imgTransform: `scale(1.1) translate(${tx}%, ${ty}%)` };
    }
    case "ken-burns-up": {
      const s = interpolate(frame, [startFrame, endFrame], [1.0, 1.08], clamp);
      const ty = interpolate(frame, [startFrame, endFrame], [0, -3], clamp);
      return { imgTransform: `scale(${s}) translateY(${ty}%)` };
    }
    case "ken-burns-down": {
      const s = interpolate(frame, [startFrame, endFrame], [1.0, 1.08], clamp);
      const ty = interpolate(frame, [startFrame, endFrame], [0, 3], clamp);
      return { imgTransform: `scale(${s}) translateY(${ty}%)` };
    }
    case "slide-in-left": {
      const slideEnd = Math.min(startFrame + SLIDE_FRAMES, endFrame);
      const tx = interpolate(frame, [startFrame, slideEnd], [-100, 0], clamp);
      return { imgTransform: "none", wrapperTransform: `translateX(${tx}%)` };
    }
    case "slide-in-right": {
      const slideEnd = Math.min(startFrame + SLIDE_FRAMES, endFrame);
      const tx = interpolate(frame, [startFrame, slideEnd], [100, 0], clamp);
      return { imgTransform: "none", wrapperTransform: `translateX(${tx}%)` };
    }
    case "slide-in-top": {
      const slideEnd = Math.min(startFrame + SLIDE_FRAMES, endFrame);
      const ty = interpolate(frame, [startFrame, slideEnd], [-100, 0], clamp);
      return { imgTransform: "none", wrapperTransform: `translateY(${ty}%)` };
    }
    case "slide-in-bottom": {
      const slideEnd = Math.min(startFrame + SLIDE_FRAMES, endFrame);
      const ty = interpolate(frame, [startFrame, slideEnd], [100, 0], clamp);
      return { imgTransform: "none", wrapperTransform: `translateY(${ty}%)` };
    }
    default:
      return { imgTransform: "none" };
  }
}

// Caption style interface (must match editor-utils.ts)
interface CaptionStyle {
  preset: string;
  fontSize: number;
  fontWeight: number;
  fontFamily: string;
  textTransform: "none" | "uppercase" | "lowercase" | "capitalize";
  activeColor: string;
  inactiveColor: string;
  positionBottom: number;
  wordsPerBatch: number;
  layout: "inline" | "stacked";
  showEmojis: boolean;
  captionBgColor?: string;
  captionBgOpacity?: number;
}

const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  preset: "default",
  fontSize: 72,
  fontWeight: 700,
  fontFamily: "system-ui",
  textTransform: "none",
  activeColor: "#FFFFFF",
  inactiveColor: "#9CA3AF",
  positionBottom: 5,
  wordsPerBatch: 1,
  layout: "inline",
  showEmojis: false,
};

// Extra track clip for overlay layers
interface ExtraClipInput {
  id: string;
  url: string;
  type: "image" | "video" | "audio";
  name: string;
  startFrame: number;
  durationFrames: number;
  volume?: number;
}

interface ExtraTrackInput {
  id: string;
  label: string;
  clips: ExtraClipInput[];
  locked?: boolean;
  visible?: boolean;
  muted?: boolean;
}

// ── Sub-components for extra tracks ──

function VideoClipSequence({
  clip, startFrame, durationFrames, trackZIndex, muted,
}: {
  clip: ExtraClipInput; startFrame: number; durationFrames: number;
  trackZIndex: number; muted: boolean;
}) {
  return (
    <Sequence from={startFrame} durationInFrames={durationFrames}>
      <AbsoluteFill style={{ zIndex: trackZIndex }}>
        <OffthreadVideo
          src={clip.url}
          pauseWhenBuffering
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
          volume={muted ? 0 : (clip.volume ?? 1)}
        />
      </AbsoluteFill>
    </Sequence>
  );
}

function AudioClipSequence({
  clip, startFrame, durationFrames, muted,
}: {
  clip: ExtraClipInput; startFrame: number; durationFrames: number; muted: boolean;
}) {
  return (
    <Sequence from={startFrame} durationInFrames={durationFrames}>
      <Audio src={clip.url} volume={muted ? 0 : (clip.volume ?? 1)} />
    </Sequence>
  );
}

function ImageClipSequence({
  clip, startFrame, durationFrames, trackZIndex,
}: {
  clip: ExtraClipInput; startFrame: number; durationFrames: number; trackZIndex: number;
}) {
  return (
    <Sequence from={startFrame} durationInFrames={durationFrames}>
      <AbsoluteFill style={{ zIndex: trackZIndex }}>
        <Img
          src={clip.url}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>
    </Sequence>
  );
}

interface RemotionVideoProps {
  script?: any[];
  audioFileUrl?: string;
  musicUrl?: string;
  voiceoverVolume?: number;
  musicVolume?: number;
  captions?: any[];
  imageList?: string[];
  clipList?: Array<{ url: string; type: "photo" | "video"; query?: string }>;
  clipDurations?: number[];
  /** Maps scene index → first clipDurations index for that scene (set when sub-clips are used). */
  sceneClipOffsets?: number[];
  setDurationInFrames?: (duration: number) => void;
  voiceoverSegments?: any[];
  imageEffects?: string[];
  imagePositions?: { x: number; y: number }[];
  showWatermark?: boolean;
  captionStyle?: Partial<CaptionStyle>;
  extraTracks?: ExtraTrackInput[];
  captionsVisible?: boolean;
  /** Number of clips for audio timing when imageList is hidden (empty). */
  audioClipCount?: number;
  /** Deterministic timeline built at generation time. When present, used as-is
   *  instead of recomputing — guarantees preview === export. */
  timeline?: TimelineItem[];
}

function RemotionVideo({
  script,
  audioFileUrl,
  musicUrl,
  voiceoverVolume = 1,
  musicVolume = 0.35,
  captions = [],
  imageList = [],
  clipList,
  clipDurations,
  sceneClipOffsets,
  setDurationInFrames,
  voiceoverSegments,
  imageEffects,
  imagePositions,
  showWatermark = true,
  captionStyle: captionStyleProp,
  extraTracks = [],
  captionsVisible = true,
  audioClipCount,
  timeline: timelineProp,
}: RemotionVideoProps) {
  // Prefer clipList (long video with typed clips); fall back to imageList (shorts-video)
  // NOTE: must check .length — an empty array [] is truthy and would wrongly override imageList
  const resolvedClips: Array<{ url: string; type: "photo" | "video" }> = (clipList && clipList.length > 0)
    ? clipList.map((clip) => {
        const url = String(clip?.url ?? "");
      const inferredType = isVideoLikeUrl(url) ? "video" as const : "photo" as const;
        // Trust the explicit clip.type from the data — only fall back to URL inference when
        // type is absent or unrecognised. Never override an explicit "video" to "photo".
        const normalizedType = clip?.type === "video" ? "video" as const
          : clip?.type === "photo" ? "photo" as const
          : inferredType;
        return { url, type: normalizedType };
      })
    : imageList.map((url) => ({
        url,
        type: isVideoLikeUrl(url) ? "video" as const : "photo" as const,
      }));
  const inferredVoiceoverClipCount = useMemo(() => {
    let maxScriptIndex = -1;
    for (const seg of voiceoverSegments ?? []) {
      if (typeof seg?.scriptIndex === "number" && seg.scriptIndex > maxScriptIndex) {
        maxScriptIndex = seg.scriptIndex;
      }
    }
    return maxScriptIndex + 1;
  }, [voiceoverSegments]);
  // Strip undefined values from prop so DEFAULT_CAPTION_STYLE fills gaps cleanly
  const cleanProp = captionStyleProp
    ? Object.fromEntries(Object.entries(captionStyleProp).filter(([, v]) => v !== undefined))
    : {};
  const captionStyle = { ...DEFAULT_CAPTION_STYLE, ...cleanProp };
  const { fps, durationInFrames: compositionDuration } = useVideoConfig();
  const frame = useCurrentFrame();

  // Keep audio timing stable even when visual clips are hidden or missing.
  const timingLength = Math.max(
    audioClipCount ?? 0,
    resolvedClips.length,
    clipDurations?.length ?? 0,
    inferredVoiceoverClipCount
  );

  // Priority: clipDurations → voiceoverSegment.durationSecs → even split from captions
  const clipTimings = useMemo((): Array<{ startFrame: number; durationFrames: number; audioFrames: number }> => {
    // ── Fast path: use the stored deterministic timeline (new videos) ─────────
    // This guarantees preview === export since both receive the exact same object.
    if (timelineProp && timelineProp.length > 0) {
      return timelineProp.map((t) => ({
        startFrame: t.startFrame,
        durationFrames: t.durationFrames,
        audioFrames: t.audioFrames,
      }));
    }

    // ── Fallback: compute from clipDurations / voiceoverSegments (old videos) ─
    // Accumulate in floating-point ms; convert to frames once per clip.
    // This avoids the per-clip integer rounding drift of the old approach.
    if (timingLength === 0) return [];

    let fallbackTotal: number;
    if (captions.length > 0) {
      fallbackTotal = Math.round((captions[captions.length - 1].end / 1000) * fps);
    } else {
      fallbackTotal = compositionDuration;
    }
    const evenDuration = Math.max(1, Math.round(fallbackTotal / Math.max(1, timingLength)));

    const segDurMap: Record<number, number> = {};
    if (voiceoverSegments) {
      for (const seg of voiceoverSegments as any[]) {
        if (seg.durationSecs > 0) segDurMap[seg.scriptIndex] = seg.durationSecs;
      }
    }

    let currentTimeMs = 0;
    return Array.from({ length: timingLength }, (_, i) => {
      let audioDurSecs: number;
      if (clipDurations?.[i] !== undefined && clipDurations[i] > 0) {
        audioDurSecs = clipDurations[i];
      } else if (segDurMap[i] !== undefined) {
        audioDurSecs = segDurMap[i];
      } else {
        audioDurSecs = evenDuration / fps;
      }

      const isVideoType = resolvedClips[i]?.type === "video";
      const audioTimeMs = audioDurSecs * 1000;
      const paddingMs = isVideoType ? 0 : (CLIP_PADDING_FRAMES / fps) * 1000;

      const startFrame = Math.floor((currentTimeMs / 1000) * fps);
      const audioEndFrame = Math.floor(((currentTimeMs + audioTimeMs) / 1000) * fps);
      const endFrame = Math.floor(((currentTimeMs + audioTimeMs + paddingMs) / 1000) * fps);

      currentTimeMs += audioTimeMs + paddingMs;

      return {
        startFrame,
        durationFrames: Math.max(1, endFrame - startFrame),
        audioFrames: Math.max(1, audioEndFrame - startFrame),
      };
    });
  }, [timelineProp, clipDurations, voiceoverSegments, captions, fps, compositionDuration, timingLength, resolvedClips]);

  const totalDurationFrames = useMemo(() => {
    if (timelineProp && timelineProp.length > 0) return timelineDurationFrames(timelineProp);
    if (clipTimings.length === 0) return compositionDuration;
    const last = clipTimings[clipTimings.length - 1];
    return last.startFrame + last.durationFrames;
  }, [timelineProp, clipTimings, compositionDuration]);

  useEffect(() => {
    setDurationInFrames?.(totalDurationFrames);
  }, [totalDurationFrames, setDurationInFrames]);

  const getCurrentCaptions = (): { text: string; isActive: boolean }[] => {
    if (!captions || captions.length === 0) return [];
    const currentTimeMs = (frame / fps) * 1000;
    const wordsPerBatch = captionStyle.wordsPerBatch;

    // Find the active caption index
    let activeIdx = captions.findIndex(w => w.start <= currentTimeMs && w.end >= currentTimeMs);
    
    // If no exact match, find most recent caption and keep showing its batch
    // until the next batch's first word starts (handles cross-clip-boundary gaps).
    if (activeIdx === -1) {
      for (let i = captions.length - 1; i >= 0; i--) {
        if (captions[i].start <= currentTimeMs) {
          const batchIdx = Math.floor(i / wordsPerBatch);
          const nextBatchFirstIdx = (batchIdx + 1) * wordsPerBatch;
          const nextBatchFirstWord = captions[nextBatchFirstIdx];
          // Keep showing if we haven't crossed into the next batch yet
          if (!nextBatchFirstWord || nextBatchFirstWord.start > currentTimeMs) {
            activeIdx = i;
          }
          break;
        }
      }
    }

    if (activeIdx === -1) return [];

    // Calculate which batch this word belongs to (0-indexed)
    // Batch 0 = words 0 to (wordsPerBatch-1)
    // Batch 1 = words wordsPerBatch to (2*wordsPerBatch-1)
    // etc.
    const batchIndex = Math.floor(activeIdx / wordsPerBatch);
    const startIdx = batchIndex * wordsPerBatch;
    const endIdx = Math.min(captions.length, startIdx + wordsPerBatch);
    
    const result: { text: string; isActive: boolean }[] = [];
    for (let i = startIdx; i < endIdx; i++) {
      result.push({
        text: captions[i].text,
        isActive: i === activeIdx,
      });
    }
    return result;
  };

  // Transform text based on style
  const transformText = (text: string): string => {
    switch (captionStyle.textTransform) {
      case "uppercase": return text.toUpperCase();
      case "lowercase": return text.toLowerCase();
      case "capitalize": return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
      default: return text;
    }
  };

  if (!script) return null;

  return (
    <AbsoluteFill style={{ backgroundColor: "black", overflow: "hidden" }}>
      {/* ── Image/Video clips with crossfade ── */}
      {Array.from({ length: timingLength }).map((_, index) => {
        const clip = resolvedClips[index];
        const { startFrame, durationFrames } = clipTimings[index] ?? { startFrame: 0, durationFrames: 1 };
        const image = clip?.url;
        if (!image) {
          return (
            <Sequence key={`gap-${index}`} from={startFrame} durationInFrames={durationFrames}>
              <AbsoluteFill style={{ backgroundColor: "black" }} />
            </Sequence>
          );
        }
        const isVideoClip = clip.type === "video";
        const endFrame = startFrame + durationFrames;
        const prevClip = index > 0 ? resolvedClips[index - 1] : undefined;
        const nextClip = index < timingLength - 1 ? resolvedClips[index + 1] : undefined;
        const prevTiming = index > 0 ? clipTimings[index - 1] : undefined;
        const nextTiming = index < timingLength - 1 ? clipTimings[index + 1] : undefined;
        const hasPrevClip =
          !!prevClip?.url &&
          !!prevTiming &&
          prevTiming.startFrame + prevTiming.durationFrames >= startFrame;
        const hasNextClip =
          !!nextClip?.url &&
          !!nextTiming &&
          nextTiming.startFrame <= endFrame;

        // Extend sequence into neighbour clips for overlap (images only).
        // Video clips must not seek beyond their file duration, so no extension.
        const seqStart = (!isVideoClip && hasPrevClip) ? startFrame - TRANSITION_FRAMES : startFrame;
        const seqEnd = (!isVideoClip && hasNextClip) ? endFrame + TRANSITION_FRAMES : endFrame;
        const seqDuration = Math.max(1, seqEnd - seqStart);

        // Crossfade opacity
        let opacity = 1;
        if (hasPrevClip && hasNextClip) {
          opacity = interpolate(
            frame,
            [
              startFrame - TRANSITION_FRAMES,
              startFrame,
              endFrame,
              endFrame + TRANSITION_FRAMES,
            ],
            [0, 1, 1, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );
        } else if (hasPrevClip) {
          opacity = interpolate(
            frame,
            [startFrame - TRANSITION_FRAMES, startFrame, endFrame],
            [0, 1, 1],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );
        } else if (hasNextClip) {
          opacity = interpolate(
            frame,
            [startFrame, endFrame, endFrame + TRANSITION_FRAMES],
            [1, 1, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          );
        }

        // Compute effect-based transforms (falls back to alternating ken burns if no effect set)
        const { imgTransform, wrapperTransform } = computeEffectTransforms(
          imageEffects?.[index], frame, startFrame, endFrame, index
        );

        // Get image position offset for focal point (converts -100 to 100 range to object-position)
        const position = imagePositions?.[index] ?? { x: 0, y: 0 };
        // Convert from -100/100 range to 0-100%
        // Y is negated: positive UI value → lower objectPositionY → content shifts DOWN
        const objectPositionX = 50 + (position.x * 0.5);
        const objectPositionY = 50 - (position.y * 0.5);

        return (
          <Sequence key={index} from={seqStart} durationInFrames={seqDuration}>
            <AbsoluteFill style={{ opacity, ...(wrapperTransform ? { transform: wrapperTransform } : {}) }}>
              {isVideoClip ? (
                <OffthreadVideo
                  src={image}
                  pauseWhenBuffering
                  muted
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    objectPosition: `${objectPositionX}% ${objectPositionY}%`,
                  }}
                />
              ) : (
                <Img
                  src={image}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    objectPosition: `${objectPositionX}% ${objectPositionY}%`,
                    transform: imgTransform,
                    willChange: "transform",
                  }}
                />
              )}
            </AbsoluteFill>
          </Sequence>
        );
      })}

      {/* ── Extra overlay tracks (Track 1 renders on top of Track 2, etc.) ── */}
      {/* Render in reverse order so Track 1 (index 0) is on top */}
      {[...extraTracks].reverse().map((track, reversedIdx) => {
        // Skip hidden tracks
        if (track.visible === false) return null;
        
        // Calculate z-index sequentially: Track 1 = highest, Track N = lowest among extra tracks
        // reversedIdx 0 = last track (z-index 1), reversedIdx n-1 = Track 1 (z-index n)
        const trackZIndex = reversedIdx + 1;
        
        return (Array.isArray(track.clips) ? track.clips : []).map((clip) => {
          const startFrame = clip.startFrame;
          const durationFrames = Math.max(1, clip.durationFrames);
          const muted = !!track.muted;
          
          if (clip.type === "video") {
            return (
              <VideoClipSequence
                key={clip.id}
                clip={clip}
                startFrame={startFrame}
                durationFrames={durationFrames}
                trackZIndex={trackZIndex}
                muted={muted}
              />
            );
          }
          
          if (clip.type === "image") {
            return (
              <ImageClipSequence
                key={clip.id}
                clip={clip}
                startFrame={startFrame}
                durationFrames={durationFrames}
                trackZIndex={trackZIndex}
              />
            );
          }
          
          if (clip.type === "audio") {
            return (
              <AudioClipSequence
                key={clip.id}
                clip={clip}
                startFrame={startFrame}
                durationFrames={durationFrames}
                muted={muted}
              />
            );
          }
          
          return null;
        });
      })}

      {/* ── Captions overlay — always on top ── */}
      {captionsVisible && (
        <AbsoluteFill
          style={{
            top: undefined,
            bottom: `${captionStyle.positionBottom}%`,
            height: "auto",
            justifyContent: "center",
            alignItems: "stretch",
            flexDirection: "column",
            textAlign: "center",
            width: "100%",
            padding: "0 20px",
            boxSizing: "border-box",
            pointerEvents: "none",
            zIndex: 100,
          }}
        >
          {(() => {
            const words = getCurrentCaptions();
            if (words.length === 0) return null;
            const bgOpacity = captionStyle.captionBgOpacity ?? 0;
            const bgHex = captionStyle.captionBgColor ?? "#000000";
            const r = parseInt(bgHex.slice(1, 3), 16) || 0;
            const g = parseInt(bgHex.slice(3, 5), 16) || 0;
            const b = parseInt(bgHex.slice(5, 7), 16) || 0;
            const bgColor = bgOpacity > 0 ? `rgba(${r},${g},${b},${bgOpacity})` : "transparent";
            const hasBg = bgOpacity > 0;
            const isStacked = captionStyle.layout === "stacked";
            return (
              <div style={{ width: "100%", textAlign: "center" }}>
                <div
                  style={{
                    display: "inline-block",
                    maxWidth: "100%",
                    boxSizing: "border-box",
                    textAlign: "center",
                    backgroundColor: bgColor,
                    borderRadius: hasBg ? 16 : 0,
                    padding: hasBg ? "4px 18px" : 0,
                    lineHeight: isStacked ? 1.4 : 1.2,
                    wordBreak: "normal",
                    overflowWrap: "normal",
                  }}
                >
                  {words.map((word, idx) => {
                    const isActive = word.isActive;
                    return (
                      <span
                        key={idx}
                        style={{
                          color: isActive ? captionStyle.activeColor : captionStyle.inactiveColor,
                          fontSize: isActive
                            ? `calc(${captionStyle.fontSize}px * 1.06)`
                            : `${captionStyle.fontSize}px`,
                          fontWeight: captionStyle.fontWeight,
                          fontFamily: captionStyle.fontFamily,
                          textShadow: hasBg ? "none" : (isActive
                            ? "2px 2px 8px rgba(0,0,0,0.9), 0 0 20px rgba(0,0,0,0.5)"
                            : "1px 1px 4px rgba(0,0,0,0.7)"),
                          display: isStacked ? "block" : "inline",
                          verticalAlign: "baseline",
                        }}
                      >
                        {transformText(word.text)}{!isStacked && idx < words.length - 1 ? " " : ""}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </AbsoluteFill>
      )}

      {/* ── Audio: Per-segment voiceover (sequenced) + background music ── */}
      {voiceoverSegments && voiceoverSegments.length > 0
        ? voiceoverSegments.map((seg: any, i: number) => {
            // When sub-clips are used, the scene's audio starts at the first sub-clip's frame.
            // Fall back to scriptIndex when no sceneClipOffsets (legacy / long-video).
            const clipIdx = sceneClipOffsets
              ? (sceneClipOffsets[seg.scriptIndex] ?? seg.scriptIndex)
              : seg.scriptIndex;
            const timing = clipTimings[clipIdx];
            if (!timing || !seg.audioUrl) return null;
            const segAudioFrames = typeof seg.durationSecs === "number" && seg.durationSecs > 0
              ? Math.max(1, Math.round(seg.durationSecs * fps))
              : (timing.audioFrames ?? timing.durationFrames);
            return (
              <Sequence key={i} from={timing.startFrame} durationInFrames={segAudioFrames}>
                <Audio
                  src={seg.audioUrl}
                  volume={seg.volume !== undefined ? seg.volume : voiceoverVolume}
                />
              </Sequence>
            );
          })
        : audioFileUrl && <Audio src={audioFileUrl} volume={voiceoverVolume} />
      }
      {musicUrl && <Audio src={musicUrl} volume={musicVolume} loop />}

      {/* ── Watermark — moves position throughout video ── */}
      {showWatermark && (
        <WatermarkOverlay frame={frame} totalFrames={totalDurationFrames} fps={fps} />
      )}
    </AbsoluteFill>
  );
}

export default RemotionVideo;
