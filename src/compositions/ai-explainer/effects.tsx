/**
 * AI Explainer — the always-on cinematic layers.
 *
 * Ported from `remotion/src/components/CinematicEffects.tsx` in the
 * `video_explainer` reference. Only the three the player actually composites
 * are here — drifting dust, an ambient floor glow, and a vignette. They sit
 * above and below every scene, so a scene that is visually flat still reads as
 * part of one film rather than a slideshow of React components.
 *
 * All motion is derived from the frame number, never from state or randomness,
 * so a given frame renders identically on every pass — which is what lets
 * Remotion render frames out of order across threads.
 */

import React, { useMemo } from "react";
import { AbsoluteFill, random, useCurrentFrame, useVideoConfig } from "remotion";

interface Particle {
  id: number;
  x: number;
  y: number;
  size: number;
  speed: number;
  opacity: number;
  drift: number;
}

/**
 * Slow-rising dust motes. `random(seed)` is Remotion's deterministic PRNG — the
 * same seed yields the same value on every thread and every render.
 */
export const PersistentParticles: React.FC<{
  count?: number;
  color?: string;
  seed?: string;
}> = ({ count = 30, color = "#ffffff", seed = "particles" }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  const particles = useMemo<Particle[]>(
    () =>
      Array.from({ length: count }, (_, i) => ({
        id: i,
        x: random(`${seed}-x-${i}`) * width,
        y: random(`${seed}-y-${i}`) * height,
        size: 1 + random(`${seed}-size-${i}`) * 3,
        speed: 0.1 + random(`${seed}-speed-${i}`) * 0.3,
        opacity: 0.1 + random(`${seed}-opacity-${i}`) * 0.2,
        drift: (random(`${seed}-drift-${i}`) - 0.5) * 0.5,
      })),
    [count, width, height, seed]
  );

  return (
    <AbsoluteFill style={{ pointerEvents: "none", zIndex: 1000 }}>
      {particles.map((p) => {
        // Wrap vertically with a 100px overscan so motes never pop in on screen.
        const yOffset = (frame * p.speed) % (height + 100);
        const xOffset = Math.sin(frame * 0.01 + p.id) * 30 * p.drift;
        const y = ((p.y - yOffset + height + 100) % (height + 100)) - 50;
        const x = p.x + xOffset;
        const twinkle = 0.7 + Math.sin(frame * 0.05 + p.id * 2) * 0.3;

        return (
          <div
            key={p.id}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: p.size,
              height: p.size,
              borderRadius: "50%",
              backgroundColor: color,
              opacity: p.opacity * twinkle,
              filter: `blur(${p.size * 0.3}px)`,
              boxShadow: `0 0 ${p.size * 2}px ${color}`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

/** Darkened edges, pulling the eye to the middle of the frame. */
export const Vignette: React.FC<{ intensity?: number }> = ({ intensity = 0.4 }) => (
  <AbsoluteFill
    style={{
      pointerEvents: "none",
      zIndex: 999,
      background: `radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,${intensity}) 100%)`,
    }}
  />
);

/** A slow breathing wash of the accent colour rising from the bottom edge. */
export const AmbientGlow: React.FC<{ color?: string; intensity?: number }> = ({
  color = "#0066FF",
  intensity = 0.15,
}) => {
  const frame = useCurrentFrame();
  const pulse = 0.7 + Math.sin(frame * 0.02) * 0.3;
  const opacity = intensity * pulse;
  const alphaHex = Math.round(Math.max(0, Math.min(1, opacity)) * 255)
    .toString(16)
    .padStart(2, "0");

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        zIndex: 1,
        background: `radial-gradient(ellipse at 50% 120%, ${color}${alphaHex} 0%, transparent 60%)`,
      }}
    />
  );
};
