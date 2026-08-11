/**
 * AI Explainer — scene-to-scene transitions.
 *
 * Ported from `remotion/src/components/CinematicTransition.tsx` in the
 * `video_explainer` reference. Two presentations for `@remotion/transitions`:
 * a focus-pull crossfade and a slide, both with a light leak that peaks in the
 * middle of the move.
 *
 * `presentationProgress` runs 0→1 across the transition for both the outgoing
 * and incoming scene; `presentationDirection` says which side you are. Every
 * effect here is a function of those two, which is why `Math.sin(progress * PI)`
 * appears repeatedly — it is the "peaks at the midpoint" curve.
 */

import React from "react";
import { AbsoluteFill, Easing, interpolate } from "remotion";
import type {
  TransitionPresentation,
  TransitionPresentationComponentProps,
} from "@remotion/transitions";

type CinematicTransitionProps = {
  accentColor?: string;
  enableBlur?: boolean;
  enableLightLeak?: boolean;
  enableChromatic?: boolean;
  enableColorPulse?: boolean;
};

const CinematicFadeComponent: React.FC<
  TransitionPresentationComponentProps<CinematicTransitionProps>
> = ({ children, presentationDirection, presentationProgress, passedProps }) => {
  const { enableBlur = true, enableLightLeak = true } = passedProps;

  const isExiting = presentationDirection === "exiting";
  const progress = presentationProgress;
  const easedProgress = Easing.inOut(Easing.cubic)(progress);

  const opacity = isExiting
    ? interpolate(easedProgress, [0, 1], [1, 0])
    : interpolate(easedProgress, [0, 1], [0, 1]);

  // Focus pull: blur peaks mid-transition, and a matching sliver of zoom hides
  // the soft edges the blur exposes at the frame boundary.
  const blurAmount = enableBlur ? Math.sin(progress * Math.PI) * 8 : 0;
  const scale = 1 + blurAmount * 0.005;

  const lightLeakOpacity = enableLightLeak ? Math.sin(progress * Math.PI) * 0.25 : 0;
  const yOffset = isExiting
    ? interpolate(easedProgress, [0, 1], [0, -15])
    : interpolate(easedProgress, [0, 1], [15, 0]);

  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{
          opacity,
          filter: blurAmount > 0.1 ? `blur(${blurAmount}px)` : "none",
          transform: `scale(${scale}) translateY(${yOffset}px)`,
          transformOrigin: "center center",
        }}
      >
        {children}
      </AbsoluteFill>

      {lightLeakOpacity > 0.01 && (
        <AbsoluteFill
          style={{
            pointerEvents: "none",
            background: isExiting
              ? `linear-gradient(to left, transparent 30%, rgba(255,255,255,${
                  lightLeakOpacity * 0.5
                }) 50%, transparent 70%)`
              : `linear-gradient(to right, transparent 30%, rgba(255,255,255,${
                  lightLeakOpacity * 0.5
                }) 50%, transparent 70%)`,
            mixBlendMode: "soft-light",
          }}
        />
      )}
    </AbsoluteFill>
  );
};

export const cinematicFade = (
  props: CinematicTransitionProps = {}
): TransitionPresentation<CinematicTransitionProps> => ({
  component: CinematicFadeComponent,
  props,
});

type CinematicSlideProps = CinematicTransitionProps & {
  slideDirection?: "left" | "right" | "up" | "down";
};

const CinematicSlideComponent: React.FC<
  TransitionPresentationComponentProps<CinematicSlideProps>
> = ({ children, presentationDirection, presentationProgress, passedProps }) => {
  const { slideDirection = "left", enableBlur = true, enableLightLeak = true } = passedProps;

  const isExiting = presentationDirection === "exiting";
  const progress = presentationProgress;
  const easedProgress = Easing.out(Easing.cubic)(progress);

  const slideAmount = 100; // percent of the frame
  let translateX = 0;
  let translateY = 0;

  // Exiting leaves toward `slideDirection`; entering arrives from the opposite
  // edge, so the pair reads as one continuous push.
  if (isExiting) {
    if (slideDirection === "left") translateX = interpolate(easedProgress, [0, 1], [0, -slideAmount]);
    else if (slideDirection === "right") translateX = interpolate(easedProgress, [0, 1], [0, slideAmount]);
    else if (slideDirection === "up") translateY = interpolate(easedProgress, [0, 1], [0, -slideAmount]);
    else translateY = interpolate(easedProgress, [0, 1], [0, slideAmount]);
  } else {
    if (slideDirection === "left") translateX = interpolate(easedProgress, [0, 1], [slideAmount, 0]);
    else if (slideDirection === "right") translateX = interpolate(easedProgress, [0, 1], [-slideAmount, 0]);
    else if (slideDirection === "up") translateY = interpolate(easedProgress, [0, 1], [slideAmount, 0]);
    else translateY = interpolate(easedProgress, [0, 1], [-slideAmount, 0]);
  }

  const blurAmount = enableBlur ? Math.sin(progress * Math.PI) * 4 : 0;
  const scale = interpolate(Math.sin(progress * Math.PI), [0, 1], [1, 0.98]);
  const lightLeakOpacity = enableLightLeak ? Math.sin(progress * Math.PI) * 0.2 : 0;

  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{
          filter: blurAmount > 0.1 ? `blur(${blurAmount}px)` : "none",
          transform: `translate(${translateX}%, ${translateY}%) scale(${scale})`,
          transformOrigin: "center center",
        }}
      >
        {children}
      </AbsoluteFill>

      {lightLeakOpacity > 0.01 && (
        <AbsoluteFill
          style={{
            pointerEvents: "none",
            background: `radial-gradient(ellipse at ${
              isExiting ? "30%" : "70%"
            } 50%, rgba(255,255,255,${lightLeakOpacity * 0.5}) 0%, transparent 60%)`,
            mixBlendMode: "soft-light",
          }}
        />
      )}
    </AbsoluteFill>
  );
};

export const cinematicSlide = (
  props: CinematicSlideProps = {}
): TransitionPresentation<CinematicSlideProps> => ({
  component: CinematicSlideComponent,
  props,
});
