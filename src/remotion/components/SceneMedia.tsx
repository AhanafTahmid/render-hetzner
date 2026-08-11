import React from "react";
import { Img, Loop } from "remotion";

import { SmartVideo } from "./SmartVideo";
import { useSceneDurationInFrames } from "./SceneDurationContext";

/**
 * A scene's visual, whether that visual turned out to be a still or a clip.
 *
 * WHY THIS EXISTS
 *
 * `imageList[i]` is a single flat list of scene visuals, and it holds BOTH: the
 * article's own mirrored images and, for any scene the article could not cover,
 * a Pexels result — which is an `.mp4` more often than not, because
 * `searchPexelsClip` prefers clips over stills.
 *
 * Every template used to render that slot with `<Img>` unconditionally. An
 * `.mp4` in an `<img>` is not a soft failure:
 *
 *   - The tag can never decode it, so it shows the broken-image glyph, and
 *   - with `pauseWhenLoading` it HANGS THE PLAYER PERMANENTLY. Remotion's `Img`
 *     takes `delayPlayback().unblock` and only calls it from its load handler.
 *     On a decode failure it falls through to `addEventListener('load', ...)`
 *     for an event that will never fire, and its error path retries and then
 *     `cancelRender()`s — it never unblocks. So the preview does not degrade,
 *     it just spins forever on a blank frame.
 *
 * That is why this component both dispatches on the URL *and* drops
 * `pauseWhenLoading` from the image path. A scene visual is decoration whose URL
 * we do not control; a broken one must cost a blank box, never the timeline. The
 * reference app makes the same call — its layouts render a plain
 * `<Img src={imageUrl} style={...} />` with no pause.
 *
 * The video path follows the reference's per-template `*Clip` components
 * (e.g. `remotion-video/src/templates/whiteboard/components/WhiteboardClip.tsx`):
 * the caller's `style` is merged LAST so a clip inherits exactly the framing,
 * Ken Burns transform and overlay treatment the still had, and the clip is
 * looped to the scene length so a short stock video does not park on its final
 * frame halfway through the narration.
 *
 * ── FRAMING CONVENTION (set by the caller, enforced everywhere) ──────────────
 *
 * Callers pass `objectFit` in `style`, and across every blog template the rule
 * is the same: **`contain` unless the user zoomed in past 1**.
 *
 * This is deliberate and easy to "fix" back by mistake. `cover` fills a
 * fixed-aspect box by cropping whatever does not fit — harmless for a stock
 * photo, destructive for the diagrams, charts and screenshots a technical
 * article is mostly made of. A wide architecture diagram dropped into a
 * half-width panel loses its right-hand third, labels and all, and the scene
 * illustrates nothing. Letterboxing against the template's own background is
 * the cheaper failure: a smaller picture beats an unreadable one.
 *
 * `cover` remains reachable through the editor's adjust modal (zoom > 1), where
 * cropping is the explicit intent and `imageObjectPosition` chooses what to keep.
 */

/**
 * URLs that must be rendered as video rather than as an image.
 *
 * Kept in sync with `isVideoUrl()` in `lib/video-generation.ts` and
 * `isVideoLikeUrl()` in `app/dashboard/_components/RemotionVideo.tsx`. It is
 * duplicated rather than imported because this module is bundled into the
 * Remotion composition, and `lib/video-generation.ts` pulls in server-only code.
 */
export function isVideoSrc(url: string | undefined | null): boolean {
  if (!url) return false;
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

export const SceneMedia: React.FC<{
  src: string;
  style?: React.CSSProperties;
  alt?: string;
  className?: string;
  /** Muted by default: scene audio is the voiceover, not the stock clip. */
  muted?: boolean;
  volume?: number;
  /** Start offset into the source clip, in frames. */
  startInFrames?: number;
  /** Source clip length in frames, when known. Enables clean looping. */
  videoDurationInFrames?: number;
}> = ({
  src,
  style,
  alt = "",
  className,
  muted = true,
  volume = 0,
  startInFrames = 0,
  videoDurationInFrames,
}) => {
  const sceneDurationInFrames = useSceneDurationInFrames();

  if (!isVideoSrc(src)) {
    // No `pauseWhenLoading` — see the note above. A still that fails to load
    // leaves a blank box and playback continues.
    return <Img src={src} alt={alt} className={className} style={style} />;
  }

  const start = Math.max(0, Math.round(startInFrames || 0));

  const video = (
    <SmartVideo
      src={src}
      className={className}
      muted={muted}
      volume={muted ? 0 : Math.max(0, Math.min(1, volume))}
      trimBefore={start || undefined}
      style={{ width: "100%", height: "100%", display: "block", ...style }}
    />
  );

  // Loop the scene's trimmed window: [start, start + sceneDur), capped by the
  // clip's own end. Without a known clip length there is nothing to loop
  // against, so the clip simply plays through.
  const loopFrames = (() => {
    const clipLen =
      videoDurationInFrames && videoDurationInFrames > 0 ? Math.round(videoDurationInFrames) : 0;
    if (clipLen <= 0) return undefined;
    const maxWindow = Math.max(1, clipLen - start);
    if (sceneDurationInFrames && sceneDurationInFrames > 0) {
      return Math.max(1, Math.min(Math.round(sceneDurationInFrames), maxWindow));
    }
    return maxWindow;
  })();

  // layout="none": <Loop> renders a <Sequence>, which defaults to an
  // AbsoluteFill wrapper. That wrapper contributes no intrinsic height, so in a
  // flex/auto-height caller a `height: 100%` clip collapses to 0 and renders
  // invisibly. "none" drops the wrapper so the video flows exactly like the
  // <Img> it replaces.
  return loopFrames ? (
    <Loop durationInFrames={loopFrames} layout="none">
      {video}
    </Loop>
  ) : (
    video
  );
};
