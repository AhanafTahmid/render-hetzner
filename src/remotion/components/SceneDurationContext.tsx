import { createContext, useContext } from "react";

/**
 * Scene length in frames — provided by the per-scene <Sequence> wrapper.
 *
 * A <Sequence> knows its own `durationInFrames`, but nothing inside it can read
 * that back: `useVideoConfig()` reports the COMPOSITION's duration, not the
 * sequence's. `SceneMedia` needs the scene length so it can loop a stock clip
 * that is shorter than the narration instead of parking on its last frame, so
 * the wrapper hands it down explicitly.
 *
 * Ported from the blog2video reference app
 * (`remotion-video/src/templates/SceneDurationContext.tsx`).
 */
export const SceneDurationInFramesContext = createContext<number | undefined>(undefined);

export function useSceneDurationInFrames(): number | undefined {
  return useContext(SceneDurationInFramesContext);
}
