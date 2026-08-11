import React from "react";

import { SceneMedia } from "../../../components/SceneMedia";

/**
 * Scene visual framing: pan (object-position) + zoom (scale) clipped inside a fixed box.
 *
 * zoom == 1 (default) → object-fit: contain — THE WHOLE IMAGE IS VISIBLE.
 * zoom  >  1          → object-fit: cover + scale(z) from the focus point (deliberate crop)
 * zoom  <  1          → object-fit: contain + scale(z) from center (shrinks within the box)
 *
 * Why `contain` is the default: these boxes have a fixed aspect ratio and the
 * article's images do not. `cover` fills the box by cropping whatever does not
 * fit, which is fine for a photo and wrong for the diagrams, charts and
 * screenshots a technical article is mostly made of — it silently slices the
 * right-hand third off a wide architecture diagram, labels and all, and the
 * scene ends up illustrating nothing. Letterboxing against the template's own
 * background is the lesser cost: a smaller picture beats an unreadable one.
 *
 * `cover` is still reachable, but only when someone asks for it by zooming past
 * 1 in the editor's adjust modal — at which point cropping is the intent, and
 * `imageObjectPosition` says which part to keep.
 *
 * `src` may be a still OR a stock clip — scenes the source article could not
 * cover are filled from Pexels, which returns `.mp4` more often than not.
 * `SceneMedia` picks the right primitive; the framing math below is identical
 * either way, so a clip is framed exactly like the still it replaces.
 */
export function ZoomCropImg({
  src,
  imageObjectPosition,
  imageZoom,
  alt = "",
  videoDurationInFrames,
  videoStartInFrames,
}: {
  src: string;
  imageObjectPosition?: string;
  imageZoom?: number;
  alt?: string;
  videoDurationInFrames?: number;
  videoStartInFrames?: number;
}) {
  const pos = imageObjectPosition ?? "50% 50%";
  const z = Math.max(0.1, imageZoom ?? 1);
  // Only an explicit zoom-IN crops. Everything else shows the whole frame.
  const isZoomedIn = z > 1;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      <SceneMedia
        src={src}
        alt={alt}
        videoDurationInFrames={videoDurationInFrames}
        startInFrames={videoStartInFrames}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: "100%",
          height: "100%",
          objectFit: isZoomedIn ? "cover" : "contain",
          objectPosition: isZoomedIn ? pos : "center",
          transform: `scale(${z})`,
          transformOrigin: isZoomedIn ? pos : "center center",
        }}
      />
    </div>
  );
}
