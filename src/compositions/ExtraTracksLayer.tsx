"use client";

import React from "react";
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence } from "remotion";

/**
 * The vidgpt editor's overlay tracks ("Track 1", "Track 2", …) rendered as
 * Remotion layers. Mirror of app/dashboard/_components/ExtraTracksLayer.tsx in
 * the vidgpt repo — keep the two in sync or the export stops matching the
 * preview.
 *
 * Stacking follows the timeline: what sits higher in the track list paints in
 * front. Track 1 is the topmost row, so it gets the highest z-index. The whole
 * stack is wrapped in one layer at `baseZIndex`, which puts every overlay above
 * the scenes and their text while leaving the captions (drawn at 100 by both
 * compositions) on top.
 */

export interface ExtraClipInput {
  id: string;
  url: string;
  type: "image" | "video" | "audio";
  name: string;
  startFrame: number;
  durationFrames: number;
  /** Where the clip begins inside its own file, in frames. See the layer below. */
  sourceStartFrame?: number;
  volume?: number;
}

export interface ExtraTrackInput {
  id: string;
  label: string;
  clips: ExtraClipInput[];
  locked?: boolean;
  visible?: boolean;
  muted?: boolean;
}

function VideoClipSequence({
  clip, startFrame, durationFrames, trackZIndex, muted,
}: {
  clip: ExtraClipInput; startFrame: number; durationFrames: number;
  trackZIndex: number; muted: boolean;
}) {
  return (
    <Sequence from={startFrame} durationInFrames={durationFrames}>
      <AbsoluteFill style={{ zIndex: trackZIndex }}>
        {/* startFrom is where the clip begins inside its own file — set by a
            left-edge trim or a split. Without it a left-trim threw away the
            tail instead of the head, and both halves of a split replayed the
            same opening seconds. */}
        <OffthreadVideo
          src={clip.url}
          startFrom={Math.max(0, Math.round(clip.sourceStartFrame ?? 0))}
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
      <Audio src={clip.url} startFrom={Math.max(0, Math.round(clip.sourceStartFrame ?? 0))} volume={muted ? 0 : (clip.volume ?? 1)} />
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

export function ExtraTracksLayer({
  extraTracks = [],
  rate = 1,
  baseZIndex = 60,
}: {
  extraTracks?: ExtraTrackInput[];
  /**
   * Baked-in playback speed. Clip frames come from the editor timeline, which is
   * always 1×, so they are scaled to match scenes that were shortened by the
   * same rate — otherwise an overlay drifts off its scene in a sped-up export.
   */
  rate?: number;
  /**
   * Where the whole overlay stack sits relative to the composition's other
   * layers. The default clears scene content and scene text (which VidgptVideo
   * draws at 50) while staying under the captions at 100. The numeric value also
   * makes this a stacking context, so the per-track indices below stay contained
   * and can't be outranked by anything inside a scene.
   */
  baseZIndex?: number;
}) {
  const speed = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const tracks = Array.isArray(extraTracks) ? extraTracks : [];
  if (!tracks.length) return null;

  // Reversed so the last track is emitted first and Track 1 (index 0) ends up
  // with the highest z-index.
  return (
    <AbsoluteFill style={{ zIndex: baseZIndex, pointerEvents: "none" }}>
      {[...tracks].reverse().map((track, reversedIdx) => {
        if (!track || track.visible === false) return null;
        const trackZIndex = reversedIdx + 1;
        const muted = !!track.muted;

        return (Array.isArray(track.clips) ? track.clips : []).map((clip) => {
          const startFrame = Math.round((clip.startFrame ?? 0) / speed);
          const durationFrames = Math.max(1, Math.round((clip.durationFrames ?? 1) / speed));

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
    </AbsoluteFill>
  );
}

export default ExtraTracksLayer;
