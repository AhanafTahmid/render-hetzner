/**
 * WeddingVideo — Cringy Indian wedding photo-studio overlay edit.
 *
 * Photos float ABOVE the background videos with:
 *  - 360° spin entrances (multiple rotations)
 *  - Photo shatter: grid of tiles fly in from random positions and lock into place
 *  - Slow continuous spin while floating
 *  - Random re-spin bursts mid-video
 *  - Neon glowing hearts, falling rose petals
 *  - VHS scanlines, blinking REC timestamp
 *
 * 30 s × 30 fps = 900 frames, 1080 × 1920
 */

import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WeddingVideoProps {
  bridePhotoUrl?: string;
  groomPhotoUrl?: string;
  bgVideoUrls?: string[];
  effects?: string[];
  transition?: string;
  musicUrl?: string;
  musicVolume?: number;
  showWatermark?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };

function seeded(seed: number) {
  const x = Math.sin(seed + 1) * 10000;
  return x - Math.floor(x);
}

// ─── Scene timeline ───────────────────────────────────────────────────────────

const SCENES = [
  { start: 0,   end: 225 },
  { start: 225, end: 450 },
  { start: 450, end: 675 },
  { start: 675, end: 900 },
];

// ─── Background scene with crossfade ─────────────────────────────────────────

function BgScene({ url, sceneIdx, frame }: { url: string; sceneIdx: number; frame: number }) {
  const { start, end } = SCENES[sceneIdx] ?? { start: 0, end: 900 };
  const fadeIn  = interpolate(frame, [start, start + 18], [0, 1], clamp);
  const fadeOut = interpolate(frame, [end - 18, end], [1, 0], clamp);
  const opacity = Math.min(fadeIn, fadeOut);
  const isVideo = url.includes(".mp4") || url.includes("videos.pexels") || url.includes("vimeo");
  return (
    <AbsoluteFill style={{ opacity, zIndex: 0 }}>
      {isVideo ? (
        <OffthreadVideo
          src={url} pauseWhenBuffering muted
          style={{ width: "100%", height: "100%", objectFit: "cover", filter: "brightness(0.45) saturate(1.5)" }}
        />
      ) : (
        <Img src={url} style={{ width: "100%", height: "100%", objectFit: "cover", filter: "brightness(0.45) saturate(1.5)" }} />
      )}
    </AbsoluteFill>
  );
}

// ─── Photo shatter / assemble effect ─────────────────────────────────────────
// Divides photo into COLS×ROWS tiles; each tile flies from a random off-screen
// position and lands in its correct grid slot.

const COLS = 4;
const ROWS = 5;

function ShatterPhoto({
  url, progress, style,
}: {
  url: string;
  // 0 = fully scattered, 1 = fully assembled
  progress: number;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ position: "relative", width: "100%", height: "100%", ...style }}>
      {Array.from({ length: ROWS }).map((_, row) =>
        Array.from({ length: COLS }).map((_, col) => {
          const idx  = row * COLS + col;
          const seed = idx * 137 + 7;

          // Random launch position (off-screen)
          const fromX = (seeded(seed)     * 2 - 1) * 160; // % of container width
          const fromY = (seeded(seed + 1) * 2 - 1) * 160;
          const fromR = (seeded(seed + 2) * 2 - 1) * 720; // random start rotation

          const tx  = interpolate(progress, [0, 1], [fromX, 0], clamp);
          const ty  = interpolate(progress, [0, 1], [fromY, 0], clamp);
          const rot = interpolate(progress, [0, 1], [fromR, 0], clamp);
          const op  = interpolate(progress, [0, 0.2, 1], [0, 1, 1], clamp);

          const wPct = 100 / COLS;
          const hPct = 100 / ROWS;

          return (
            <div
              key={`${row}-${col}`}
              style={{
                position: "absolute",
                left:   `${col * wPct}%`,
                top:    `${row * hPct}%`,
                width:  `${wPct}%`,
                height: `${hPct}%`,
                overflow: "hidden",
                transform: `translate(${tx}%, ${ty}%) rotate(${rot}deg)`,
                opacity: op,
              }}
            >
              <Img
                src={url}
                style={{
                  position: "absolute",
                  width:  `${COLS * 100}%`,
                  height: `${ROWS * 100}%`,
                  left:   `-${col * 100}%`,
                  top:    `-${row * 100}%`,
                  objectFit: "cover",
                }}
              />
            </div>
          );
        })
      )}
    </div>
  );
}

// ─── Spinning photo card ──────────────────────────────────────────────────────
// Renders a photo in a glowing bordered card that:
//  1. Spins 360°×spinCount on entrance
//  2. Drifts with a slow continuous spin afterward
//  3. Re-spins 360° at burst frames (random mid-video)

function SpinPhotoCard({
  url, role, frame, enterFrame, spinCount = 2, burstFrames = [],
}: {
  url: string;
  role: "bride" | "groom";
  frame: number;
  enterFrame: number;
  spinCount?: number;
  burstFrames?: number[];
}) {
  const isBride = role === "bride";
  const spinDuration = 55;
  const slideDuration = 80;

  // Entrance slide (left for bride, right for groom)
  const slideX = interpolate(frame, [enterFrame, enterFrame + slideDuration], [isBride ? -65 : 65, 0], clamp);

  // Entrance scale
  const entryScale = interpolate(
    frame,
    [enterFrame, enterFrame + 35, enterFrame + 55, enterFrame + 80],
    [0.25, 1.12, 0.95, 1.0],
    clamp
  );

  // Entrance 360 spin
  const entrySpin = interpolate(frame, [enterFrame, enterFrame + spinDuration], [0, 360 * spinCount], clamp);

  // Slow continuous drift after entrance
  const driftRot = frame > enterFrame + spinDuration
    ? (frame - enterFrame - spinDuration) * 0.35
    : 0;

  // Mid-video burst spins
  let burstRot = 0;
  for (const bf of burstFrames) {
    if (frame >= bf && frame < bf + spinDuration) {
      burstRot += interpolate(frame, [bf, bf + spinDuration], [0, 360], clamp);
    }
  }

  const totalRot = frame < enterFrame + spinDuration ? entrySpin : driftRot + burstRot;

  // Gentle float (vertical bob)
  const floatY = Math.sin(frame * 0.06 + (isBride ? 0 : Math.PI)) * 8;

  const opacity = interpolate(frame, [enterFrame, enterFrame + 20], [0, 1], clamp);

  const borderColor = isBride ? "#FF69B4" : "#FFD700";
  const glowColor   = isBride ? "rgba(255,105,180,0.75)" : "rgba(255,215,0,0.65)";
  const labelBg     = isBride ? "linear-gradient(90deg,#FF1493,#FF69B4)" : "linear-gradient(90deg,#DAA520,#FFD700)";

  return (
    <div style={{
      position: "absolute",
      [isBride ? "left" : "right"]: "3%",
      top: "50%",
      width: "42%",
      transform: `translateY(calc(-50% + ${floatY}px)) translateX(${slideX}%) rotate(${totalRot}deg) scale(${entryScale})`,
      display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
      opacity, zIndex: 30,
    }}>
      {/* Photo with glowing border */}
      <div style={{
        width: "100%", aspectRatio: "3/4", borderRadius: 14, overflow: "hidden",
        border: `5px solid ${borderColor}`,
        boxShadow: `0 0 28px ${glowColor}, 0 0 55px ${glowColor}, 0 0 90px ${glowColor}55`,
      }}>
        <Img src={url} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
      {/* Label */}
      <div style={{
        background: labelBg, color: isBride ? "#fff" : "#111",
        fontSize: 26, fontWeight: "bold", fontFamily: "serif",
        letterSpacing: "0.15em", textTransform: "uppercase",
        padding: "5px 18px", borderRadius: 50,
        boxShadow: `0 3px 16px ${glowColor}`,
        textShadow: isBride ? "0 1px 3px rgba(0,0,0,0.5)" : "none",
        whiteSpace: "nowrap",
      }}>
        {isBride ? "♥ Bride ♥" : "♦ Groom ♦"}
      </div>
    </div>
  );
}

// ─── Shatter + assemble sequence ─────────────────────────────────────────────
// Plays a 3-phase animation: shatter in (tiles fly in) → hold → shatter out (tiles fly away)

function ShatterSequence({
  url, role, frame, startFrame, holdDuration = 60,
}: {
  url: string;
  role: "bride" | "groom";
  frame: number;
  startFrame: number;
  holdDuration?: number;
}) {
  const inDuration  = 35;
  const outDuration = 35;
  const totalDuration = inDuration + holdDuration + outDuration;

  if (frame < startFrame || frame > startFrame + totalDuration) return null;

  const local = frame - startFrame;

  const isBride = role === "bride";
  const borderColor = isBride ? "#FF69B4" : "#FFD700";
  const glowColor   = isBride ? "rgba(255,105,180,0.7)" : "rgba(255,215,0,0.6)";

  let progress: number;
  if (local < inDuration) {
    progress = interpolate(local, [0, inDuration], [0, 1], clamp);
  } else if (local < inDuration + holdDuration) {
    progress = 1;
  } else {
    progress = interpolate(local, [inDuration + holdDuration, inDuration + holdDuration + outDuration], [1, 0], clamp);
  }

  return (
    <AbsoluteFill style={{ zIndex: 50 }}>
      <div style={{
        position: "absolute",
        [isBride ? "left" : "right"]: "5%",
        top: "25%",
        width: "38%",
        height: "50%",
        border: `4px solid ${borderColor}`,
        borderRadius: 12,
        overflow: "hidden",
        boxShadow: `0 0 30px ${glowColor}, 0 0 60px ${glowColor}`,
      }}>
        <ShatterPhoto url={url} progress={progress} />
      </div>
    </AbsoluteFill>
  );
}

// ─── Neon hearts ─────────────────────────────────────────────────────────────

const HEART_POSITIONS = [
  [7,  18, 50, "#FF69B4",  0,  0.8],
  [84, 14, 38, "#9B59B6", 12, 1.0],
  [11, 63, 58, "#3498DB", 28, 0.7],
  [79, 68, 42, "#DA70D6",  6, 0.9],
  [46,  8, 32, "#FF1493", 42, 1.1],
  [51, 78, 46, "#7B68EE", 18, 0.85],
  [24, 38, 34, "#FF69B4", 58, 1.2],
  [69, 43, 40, "#9B59B6", 33, 0.75],
];

function NeonHearts({ frame }: { frame: number }) {
  return (
    <AbsoluteFill style={{ zIndex: 40, pointerEvents: "none" }}>
      {HEART_POSITIONS.map(([x, y, size, color, delay, speed], i) => {
        const t      = Math.max(0, frame - (delay as number));
        const pulse  = Math.sin(t * (speed as number) * 0.12) * 0.2 + 0.9;
        const floatY = Math.sin(t * (speed as number) * 0.07) * 9;
        const op     = interpolate(t, [0, 15], [0, 1], clamp);
        return (
          <div key={i} style={{
            position: "absolute", left: `${x}%`, top: `${y}%`,
            transform: `translateY(${floatY}px) scale(${pulse})`,
            opacity: op, fontSize: size as number, lineHeight: 1,
            filter: `drop-shadow(0 0 ${(size as number) * 0.3}px ${color}) drop-shadow(0 0 ${(size as number) * 0.6}px ${color})`,
            pointerEvents: "none",
          }}>❤️</div>
        );
      })}
    </AbsoluteFill>
  );
}

// ─── Rose petals ─────────────────────────────────────────────────────────────

function RosePetals({ frame }: { frame: number }) {
  return (
    <AbsoluteFill style={{ zIndex: 38, pointerEvents: "none" }}>
      {Array.from({ length: 22 }).map((_, i) => {
        const x     = seeded(i * 11) * 100;
        const speed = 0.17 + seeded(i * 7) * 0.2;
        const rawY  = ((frame * speed + seeded(i * 3) * 100)) % 130 - 10;
        const size  = 13 + seeded(i * 5) * 18;
        const rot   = (frame * (seeded(i * 13) * 2 - 1) * 1.5 + i * 40) % 360;
        const swayX = Math.sin(frame * 0.04 + i) * 10;
        const op    = interpolate(rawY, [100, 120], [1, 0], clamp) * 0.8;
        return (
          <div key={i} style={{
            position: "absolute", left: `${x + swayX * 0.3}%`, top: `${rawY}%`,
            width: size, height: size * 0.7,
            borderRadius: "50% 20% 50% 20%",
            background: `hsl(${340 + seeded(i * 17) * 30}, 85%, ${50 + seeded(i * 19) * 20}%)`,
            transform: `rotate(${rot}deg)`, opacity: op,
            filter: "drop-shadow(0 1px 2px rgba(200,0,50,0.3))",
          }} />
        );
      })}
    </AbsoluteFill>
  );
}

// ─── Glitter ─────────────────────────────────────────────────────────────────

function GlitterShower({ frame }: { frame: number }) {
  return (
    <AbsoluteFill style={{ zIndex: 42, pointerEvents: "none" }}>
      {Array.from({ length: 30 }).map((_, i) => {
        const x     = seeded(i * 13) * 100;
        const fallY = (seeded(i * 7) * 100 + frame * 0.22 + i * 4) % 110;
        const size  = 4 + seeded(i * 3) * 8;
        const color = i % 3 === 0 ? "#FFD700" : i % 3 === 1 ? "#FF69B4" : "#C0C0C0";
        const op    = 0.5 + seeded(i * 17 + frame * 0.01) * 0.5;
        return (
          <div key={i} style={{
            position: "absolute", left: `${x}%`, top: `${fallY}%`,
            width: size, height: size, borderRadius: "50%",
            background: color, boxShadow: `0 0 ${size * 2}px ${color}`, opacity: op,
          }} />
        );
      })}
    </AbsoluteFill>
  );
}

// ─── VHS overlays ─────────────────────────────────────────────────────────────

function Scanlines() {
  return (
    <AbsoluteFill style={{
      zIndex: 60, pointerEvents: "none",
      backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.16) 3px, rgba(0,0,0,0.16) 4px)",
      opacity: 0.55,
    }} />
  );
}

function VhsTimestamp({ frame, fps }: { frame: number; fps: number }) {
  const blink = Math.floor(frame / (fps * 0.5)) % 2 === 0;
  const secs = Math.floor(frame / fps);
  const hh = String(13 + Math.floor(secs / 3600)).padStart(2, "0");
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return (
    <AbsoluteFill style={{ zIndex: 70, pointerEvents: "none" }}>
      <div style={{ position: "absolute", top: 24, right: 28, display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ color: "red", fontSize: 24, opacity: blink ? 1 : 0, fontFamily: "monospace", fontWeight: "bold" }}>●</span>
        <span style={{ color: "#fff", fontSize: 22, fontFamily: "monospace", fontWeight: "bold", textShadow: "0 0 8px rgba(255,0,0,0.9)" }}>
          REC {hh}:{mm}:{ss}  14/02/1994
        </span>
      </div>
    </AbsoluteFill>
  );
}

// ─── Text overlay ─────────────────────────────────────────────────────────────

function TextOverlay({ frame, showStart, showEnd, line1, line2 }: {
  frame: number; showStart: number; showEnd: number; line1: string; line2?: string;
}) {
  const opacity = interpolate(frame, [showStart, showStart + 18, showEnd - 18, showEnd], [0, 1, 1, 0], clamp);
  const scale   = interpolate(frame, [showStart, showStart + 25], [0.65, 1], clamp);
  return (
    <AbsoluteFill style={{
      zIndex: 65, display: "flex", alignItems: "center", justifyContent: "center",
      opacity, transform: `scale(${scale})`, pointerEvents: "none",
    }}>
      <div style={{
        textAlign: "center", padding: "24px 44px",
        background: "rgba(0,0,0,0.6)",
        border: "2px solid rgba(255,215,0,0.55)", borderRadius: 18,
        boxShadow: "0 0 40px rgba(255,105,180,0.25), 0 0 80px rgba(150,0,200,0.15)",
      }}>
        <div style={{
          fontSize: 68, fontFamily: "serif", fontWeight: "bold", color: "#FFD700",
          textShadow: "0 0 20px rgba(255,215,0,0.9), 2px 2px 0 #8B6914, 4px 4px 0 #5C450D",
          letterSpacing: "0.04em",
        }}>{line1}</div>
        {line2 && (
          <div style={{
            fontSize: 36, fontFamily: "serif", color: "#FFB6C1", marginTop: 8,
            letterSpacing: "0.2em", textTransform: "uppercase",
            textShadow: "0 0 12px rgba(255,182,193,0.7)",
          }}>{line2}</div>
        )}
      </div>
    </AbsoluteFill>
  );
}

// ─── Random spin burst indicator ─────────────────────────────────────────────
// Shows a flash when a burst spin triggers

function SpinFlash({ frame, triggerFrame }: { frame: number; triggerFrame: number }) {
  if (frame < triggerFrame || frame > triggerFrame + 12) return null;
  const op = interpolate(frame, [triggerFrame, triggerFrame + 6, triggerFrame + 12], [0, 0.7, 0], clamp);
  return (
    <AbsoluteFill style={{ zIndex: 55, pointerEvents: "none", background: `rgba(255,215,0,${op})`, mixBlendMode: "screen" }} />
  );
}

// ─── Main composition ─────────────────────────────────────────────────────────

export function WeddingVideo({
  bridePhotoUrl,
  groomPhotoUrl,
  bgVideoUrls = [],
  effects = ["static", "glitter", "roses", "timestamp"],
  musicUrl,
  musicVolume = 0.75,
  showWatermark = true,
}: WeddingVideoProps) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const hasEffect = (e: string) => effects.includes(e);

  const bgs = [
    bgVideoUrls[0] ?? "https://images.pexels.com/photos/931177/pexels-photo-931177.jpeg",
    bgVideoUrls[1] ?? "https://images.pexels.com/photos/1387174/pexels-photo-1387174.jpeg",
    bgVideoUrls[2] ?? "https://images.pexels.com/photos/1456613/pexels-photo-1456613.jpeg",
    bgVideoUrls[3] ?? "https://images.pexels.com/photos/3573382/pexels-photo-3573382.jpeg",
  ];

  const globalOpacity = interpolate(frame, [0, 20, durationInFrames - 20, durationInFrames], [0, 1, 1, 0], clamp);

  // Burst spin frames for bride and groom (random but deterministic)
  const brideBursts = [200, 380, 600, 760];
  const groomBursts = [340, 520, 680, 820];

  // Shatter sequences
  // Bride: shatter at frame 150, groom: shatter at frame 390
  const BRIDE_SHATTER  = 150;
  const GROOM_SHATTER  = 390;
  // Second round shatters
  const BRIDE_SHATTER2 = 560;
  const GROOM_SHATTER2 = 700;

  const hasBride = !!bridePhotoUrl;
  const hasGroom = !!groomPhotoUrl;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000", opacity: globalOpacity }}>

      {/* ── Backgrounds ── */}
      {bgs.map((url, i) => <BgScene key={i} url={url} sceneIdx={i} frame={frame} />)}

      {/* ── Colour grade ── */}
      <AbsoluteFill style={{
        zIndex: 4, pointerEvents: "none",
        background: "linear-gradient(135deg,rgba(255,0,100,0.07),rgba(100,0,200,0.06),rgba(0,100,255,0.04))",
        mixBlendMode: "screen",
      }} />

      {/* ── Vignette ── */}
      <AbsoluteFill style={{
        zIndex: 5, pointerEvents: "none",
        background: "radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.6) 100%)",
      }} />

      {/* ── Rose petals ── */}
      {hasEffect("roses") && <RosePetals frame={frame} />}

      {/* ── Glitter ── */}
      {hasEffect("glitter") && <GlitterShower frame={frame} />}

      {/* ── Neon hearts ── */}
      <NeonHearts frame={frame} />

      {/* ── Bride: main spinning card (enters at frame 40) ── */}
      {hasBride && (
        <SpinPhotoCard
          url={bridePhotoUrl!}
          role="bride"
          frame={frame}
          enterFrame={40}
          spinCount={2}
          burstFrames={brideBursts}
        />
      )}

      {/* ── Bride: shatter sequences ── */}
      {hasBride && <ShatterSequence url={bridePhotoUrl!} role="bride" frame={frame} startFrame={BRIDE_SHATTER}  holdDuration={55} />}
      {hasBride && <ShatterSequence url={bridePhotoUrl!} role="bride" frame={frame} startFrame={BRIDE_SHATTER2} holdDuration={45} />}

      {/* ── Groom: main spinning card (enters at frame 250) ── */}
      {hasGroom && (
        <SpinPhotoCard
          url={groomPhotoUrl!}
          role="groom"
          frame={frame}
          enterFrame={250}
          spinCount={3}
          burstFrames={groomBursts}
        />
      )}

      {/* ── Groom: shatter sequences ── */}
      {hasGroom && <ShatterSequence url={groomPhotoUrl!} role="groom" frame={frame} startFrame={GROOM_SHATTER}  holdDuration={55} />}
      {hasGroom && <ShatterSequence url={groomPhotoUrl!} role="groom" frame={frame} startFrame={GROOM_SHATTER2} holdDuration={45} />}

      {/* ── Solo photo (one photo only) enters centred ── */}
      {hasGroom && !hasBride && (
        <SpinPhotoCard
          url={groomPhotoUrl!}
          role="groom"
          frame={frame}
          enterFrame={40}
          spinCount={2}
          burstFrames={brideBursts}
        />
      )}

      {/* ── Spin flash effects ── */}
      {hasBride && brideBursts.map((bf) => <SpinFlash key={bf} frame={frame} triggerFrame={bf} />)}
      {hasGroom && groomBursts.map((bf) => <SpinFlash key={bf} frame={frame} triggerFrame={bf} />)}

      {/* ── VHS scanlines ── */}
      {hasEffect("static") && <Scanlines />}

      {/* ── VHS timestamp ── */}
      {hasEffect("timestamp") && <VhsTimestamp frame={frame} fps={fps} />}

      {/* ── Text overlays ── */}
      <TextOverlay frame={frame} showStart={45}  showEnd={180} line1="✨ Shubh Vivah ✨"       line2="A Legendary Celebration" />
      <TextOverlay frame={frame} showStart={310} showEnd={440} line1="💕 Forever Together 💕" line2="Happy Married Life" />
      <TextOverlay frame={frame} showStart={680} showEnd={820} line1="❤️ Happy Married Life ❤️" line2="With Love & Roses" />

      {/* ── Outro ── */}
      {frame >= 855 && (
        <AbsoluteFill style={{
          zIndex: 80,
          background: `rgba(0,0,0,${interpolate(frame, [855, 900], [0, 0.78], clamp)})`,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          pointerEvents: "none",
        }}>
          <div style={{ fontSize: 80, fontFamily: "serif", fontWeight: "bold", color: "#FFD700", textAlign: "center", textShadow: "0 0 30px rgba(255,215,0,0.8)" }}>
            📼 The End 📼
          </div>
          <div style={{ fontSize: 34, fontFamily: "serif", color: "#FFB6C1", marginTop: 20, letterSpacing: "0.15em" }}>
            Please Rewind After Viewing
          </div>
        </AbsoluteFill>
      )}

      {/* ── Music ── */}
      {musicUrl && <Audio src={musicUrl} volume={musicVolume} />}

      {/* ── Watermark ── */}
      {showWatermark && (
        <AbsoluteFill style={{ zIndex: 90, pointerEvents: "none" }}>
          <div style={{ position: "absolute", bottom: 28, right: 28, color: "rgba(255,255,255,0.4)", fontSize: 22, fontFamily: "system-ui", fontWeight: 700, textShadow: "0 1px 4px rgba(0,0,0,0.6)" }}>
            vidshero.com
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
}
