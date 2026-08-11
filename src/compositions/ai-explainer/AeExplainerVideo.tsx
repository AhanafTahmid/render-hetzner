/**
 * AI Explainer — the composition the render server renders.
 *
 * Every other template's mp4 comes from a composition whose code shipped with
 * the repo. AE's scenes are written per-video by a model, so this composition
 * takes them as *input props*: the storyboard, plus the same compiled scene
 * bundle the dashboard player evaluates (`lib/ai-explainer/preview.ts` →
 * `buildAeRegistry`). Remotion's headless browser evaluates them exactly the way
 * the dashboard does, which is what makes "what you previewed is what you
 * download" true by construction rather than by two implementations agreeing.
 *
 * This replaced an in-process render (`lib/ai-explainer/render.ts`) that
 * webpack-bundled a temp workspace on the Next.js server itself. That path
 * could not be queued, retried, observed or moved off the web server — and it
 * left `render` stages stuck `running` forever whenever the process restarted
 * mid-render. Going through a registered composition is what lets AE use the
 * same Hetzner render server, the same cost accounting, and the same Inngest
 * durability as everything else.
 *
 * Props are JSON only. The bundle is strings, the storyboard is data — nothing
 * here is a React component, because Remotion serialises input props to Node
 * when it selects a composition and a function would not survive the trip.
 */

import React, { useMemo } from "react";
import { AbsoluteFill } from "remotion";
import type { CalculateMetadataFunction } from "remotion";

import {
  AeSceneStoryboardPlayer,
  type AeSceneComponent,
  type AeStoryboard,
} from "./SceneStoryboardPlayer";
import { buildAeRegistry, type AePreviewBundle } from "./registry";
import "./fonts";

/**
 * The index signature is what `<Composition>` requires of a prop type
 * (`Record<string, unknown>`); intersecting adds it without loosening either
 * field, the same trick `AePreviewPlayer` uses for `<Player>`.
 */
export type AeExplainerVideoProps = {
  storyboard: AeStoryboard | null;
  bundle: AePreviewBundle | null;
} & Record<string, unknown>;

/**
 * Drawn instead of the video when the props never arrived.
 *
 * A composition that throws on missing props fails the render with a stack
 * trace from inside the browser, which surfaces to the user as "Render failed"
 * with nothing actionable. A frame that says what is missing is recoverable
 * information, and the Inngest function checks for both before dispatching
 * anyway — so this is the belt to that suspenders.
 */
const NoInput: React.FC<{ what: string }> = ({ what }) => (
  <AbsoluteFill
    style={{
      backgroundColor: "#1a1a2e",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "sans-serif",
      color: "#ff4757",
      fontSize: 42,
      fontWeight: 700,
    }}
  >
    Missing {what}
  </AbsoluteFill>
);

export const AeExplainerVideo: React.FC<AeExplainerVideoProps> = ({ storyboard, bundle }) => {
  // Evaluating the bundle is the expensive part of a frame and its result never
  // changes, so it is memoised on the bundle identity. Remotion renders frames
  // in the same browser context, so this is computed once per render, not 5400
  // times.
  const scenes = useMemo<Record<string, AeSceneComponent>>(
    () => (bundle ? buildAeRegistry(bundle).scenes : {}),
    [bundle]
  );

  if (!storyboard) return <NoInput what="storyboard" />;
  if (!bundle) return <NoInput what="scene bundle" />;

  return <AeSceneStoryboardPlayer storyboard={storyboard} scenes={scenes} />;
};

/**
 * Size and length come from the storyboard, because a AE project's canvas is
 * its own — the storyboard stage writes the fps and dimensions the scenes were
 * authored against, and rendering at anything else re-flows every layout.
 *
 * Must agree with `storyboardDurationInFrames` in `lib/ai-explainer/storyboard`,
 * which is what the dashboard player uses; a disagreement means the mp4 is cut
 * short or padded with black relative to the preview.
 */
export const calculateAeExplainerMetadata: CalculateMetadataFunction<
  AeExplainerVideoProps
> = ({ props }) => {
  const video = props.storyboard?.video;
  const fps = video?.fps ?? 30;
  const seconds = props.storyboard?.total_duration_seconds ?? 10;

  return {
    durationInFrames: Math.max(1, Math.ceil(seconds * fps)),
    fps,
    width: video?.width ?? 1920,
    height: video?.height ?? 1080,
  };
};
