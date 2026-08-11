import React from "react";
import { OffthreadVideo, Video, useRemotionEnvironment } from "remotion";

/**
 * Renders a clip with the right video primitive for the current Remotion
 * environment. Drop-in replacement for `<OffthreadVideo>` at every clip call
 * site — same props, same layout behaviour.
 *
 * WHY THIS EXISTS
 *
 * `OffthreadVideo` is correct for a Lambda/CLI render: Remotion extracts the
 * exact frame with ffmpeg, so output frames land on precise timestamps instead
 * of wherever a media element happened to be. That accuracy is the whole reason
 * to reach for it.
 *
 * But in the interactive Player there is no ffmpeg. `OffthreadVideo` falls back
 * to seeking a hidden <video> and holding a `delayRender()` until the requested
 * timestamp decodes — and a held `delayRender()` freezes the Player's whole
 * timeline. Playback then runs smoothly, stalls the moment it reaches a clip,
 * and stalls again at every <Loop> boundary because the restart forces a
 * backwards seek.
 *
 * `<Video>` drives a real media element that plays continuously, which is
 * exactly what preview wants and exactly what a frame-accurate render does not.
 * So: pick per environment rather than compromising on one.
 *
 * Ported from the blog2video reference app
 * (`remotion-video/src/templates/SmartVideo.tsx`), including its preview-only
 * resilience: a clip that fails to load must never halt the timeline, which is
 * the failure this whole path exists to prevent.
 */
export const SmartVideo: React.FC<{
  src: string;
  style?: React.CSSProperties;
  muted?: boolean;
  volume?: number;
  /** Start offset into the source clip, in frames. */
  trimBefore?: number;
  // Remaining props are forwarded untouched so this stays a true drop-in.
  [key: string]: unknown;
}> = ({ src, style, muted, volume, trimBefore, ...rest }) => {
  const { isRendering } = useRemotionEnvironment();

  if (isRendering) {
    return (
      <OffthreadVideo
        src={src}
        muted={muted}
        volume={volume}
        trimBefore={trimBefore}
        style={style}
        {...rest}
      />
    );
  }

  return (
    <Video
      src={src}
      muted={muted}
      volume={volume}
      trimBefore={trimBefore}
      style={style}
      {...rest}
      // Preview-only resilience: if a clip runs dry, let it catch up silently
      // instead of halting the timeline.
      pauseWhenBuffering={false}
      // A clip failing to load must never hard-fail the preview; <Video> would
      // otherwise cancelRender() on error.
      onError={() => {}}
      // Autoplay restrictions are not an error worth surfacing in preview.
      onAutoPlayError={null}
    />
  );
};
