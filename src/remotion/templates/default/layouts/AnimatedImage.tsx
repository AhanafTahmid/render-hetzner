import React from "react";

import { SceneMedia } from "../../../components/SceneMedia";

/**
 * A scene visual for the default template.
 *
 * `src` may be a still or a stock clip — scenes the source article could not
 * cover are filled from Pexels, which returns `.mp4` more often than not — so
 * this delegates to `SceneMedia`, which picks the right primitive.
 *
 * Stills (including GIFs, which show as a static first frame) render through
 * `<Img>`. Animated GIF playback only works in the server-side Remotion render,
 * where @remotion/gif runs in headless Chrome without the Player's error
 * boundary interfering.
 */
export const AnimatedImage: React.FC<{
  src: string;
  style?: React.CSSProperties;
}> = ({ src, style }) => {
  return <SceneMedia src={src} style={style} />;
};
