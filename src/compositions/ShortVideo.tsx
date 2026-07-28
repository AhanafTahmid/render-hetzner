// Extracted from shortshero/components/RemotionShortPlayer.tsx (the editor
// preview). Only the Remotion composition + its helpers are vendored here so
// the export matches the preview exactly. The Player wrapper is editor-only.
// Keep in sync with that file.
import React from "react";
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  useCurrentFrame,
  useVideoConfig,
  Sequence,
  interpolate,
} from "remotion";


export interface CaptionStyle {
  fontSize?: number;
  color?: string;
  backgroundColor?: string;
  bgOpacity?: number;
  inactiveColor?: string;
  inactiveBackgroundColor?: string;
  fontFamily?: string;
  fontWeight?: string;
  textTransform?: "uppercase" | "lowercase" | "capitalize" | "none";
  borderRadius?: number;
  padding?: string;
  textShadow?: string;
  outlineColor?: string;
  outlineWidth?: number;
  positionBottom?: number;
  wordsPerBatch?: number;
  layout?: "inline" | "stacked";
  showEmojis?: boolean;
  disabled?: boolean;
}

// ── Watermark overlay (shown for free users) ──────────────────────────────────
type WatermarkPosition = "top-right" | "top-left" | "bottom-right" | "bottom-left" | "top-center";

const WATERMARK_POSITIONS: WatermarkPosition[] = [
  "top-right", "bottom-left", "top-left", "bottom-right", "top-center",
];

function getWatermarkStyle(pos: WatermarkPosition): React.CSSProperties {
  const base: React.CSSProperties = { position: "absolute", pointerEvents: "none", display: "flex", alignItems: "center" };
  switch (pos) {
    case "top-right":    return { ...base, top: 40, right: 24 };
    case "top-left":     return { ...base, top: 40, left: 24 };
    case "bottom-right": return { ...base, bottom: 180, right: 24 };
    case "bottom-left":  return { ...base, bottom: 180, left: 24 };
    case "top-center":   return { ...base, top: 40, left: "50%", transform: "translateX(-50%)" };
    default:             return { ...base, top: 40, right: 24 };
  }
}

function WatermarkOverlay({ frame, totalFrames, fps }: { frame: number; totalFrames: number; fps: number }) {
  const segDur = 3 * fps;
  const posIdx = Math.floor(frame / segDur) % WATERMARK_POSITIONS.length;
  const pos = WATERMARK_POSITIONS[posIdx];
  const frameInSeg = frame % segDur;
  const fadeDur = Math.round(fps * 0.3);
  let opacity = 0.55;
  if (frameInSeg < fadeDur) {
    opacity = interpolate(frameInSeg, [0, fadeDur], [0.2, 0.55], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  } else if (frameInSeg > segDur - fadeDur) {
    opacity = interpolate(frameInSeg, [segDur - fadeDur, segDur], [0.55, 0.2], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  }
  return (
    <div style={getWatermarkStyle(pos)}>
      <span style={{
        color: `rgba(255,255,255,${opacity})`,
        fontSize: 28,
        fontWeight: 700,
        fontFamily: "system-ui, -apple-system, sans-serif",
        letterSpacing: 1,
        textShadow: "0 2px 8px rgba(0,0,0,0.7), 0 0 20px rgba(0,0,0,0.5)",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}>
        shortshero.com
      </span>
    </div>
  );
}

const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontSize: 88,
  color: "#000000",
  backgroundColor: "#FFFF00",
  inactiveColor: "rgba(255, 255, 255, 0.6)",
  inactiveBackgroundColor: "transparent",
  fontWeight: "900",
  textTransform: "uppercase",
  borderRadius: 15,
  padding: "15px 30px",
  textShadow: "0 10px 30px rgba(0,0,0,0.5)",
};

function hexToRgba(hex: string, opacity: number): string {
  const clean = hex.replace("#", "");
  if (clean.length < 6) return hex;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

// ── Extra track clip renderer ─────────────────────────────────────────────────
function ExtraClipLayer({ clip }: { clip: any }) {
  const frame = useCurrentFrame();
  const N = Math.max(1, clip.durationFrames ?? 30);
  const effect = clip.effect || "none";
  const speed = Math.max(0.1, clip.effectSpeed ?? 1);
  const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };

  // Apply speed by compressing the animation range — higher speed = completes sooner
  const EN = Math.max(1, N / speed);           // effective end for continuous effects
  const SLIDE_N = Math.max(1, (N * 0.6) / speed); // effective end for slide-in effects

  // Build CSS transform from effect id (matches ImageEffectsPanel EFFECTS ids)
  let transform = "";
  switch (effect) {
    case "zoom-in": {
      const s = interpolate(frame, [0, EN], [1, 1.2], clamp);
      transform = `scale(${s})`;
      break;
    }
    case "zoom-out": {
      const s = interpolate(frame, [0, EN], [1.2, 1], clamp);
      transform = `scale(${s})`;
      break;
    }
    case "scroll-left": {
      const tx = interpolate(frame, [0, EN], [5, -5], clamp);
      transform = `scale(1.1) translateX(${tx}%)`;
      break;
    }
    case "scroll-right": {
      const tx = interpolate(frame, [0, EN], [-5, 5], clamp);
      transform = `scale(1.1) translateX(${tx}%)`;
      break;
    }
    case "scroll-up": {
      const ty = interpolate(frame, [0, EN], [5, -5], clamp);
      transform = `scale(1.1) translateY(${ty}%)`;
      break;
    }
    case "scroll-down": {
      const ty = interpolate(frame, [0, EN], [-5, 5], clamp);
      transform = `scale(1.1) translateY(${ty}%)`;
      break;
    }
    case "ken-burns-up": {
      const s = interpolate(frame, [0, EN], [1, 1.08], clamp);
      const ty = interpolate(frame, [0, EN], [0, -3], clamp);
      transform = `scale(${s}) translateY(${ty}%)`;
      break;
    }
    case "ken-burns-down": {
      const s = interpolate(frame, [0, EN], [1, 1.08], clamp);
      const ty = interpolate(frame, [0, EN], [0, 3], clamp);
      transform = `scale(${s}) translateY(${ty}%)`;
      break;
    }
    case "diagonal-up-left": {
      const tx = interpolate(frame, [0, EN], [2, -2], clamp);
      const ty = interpolate(frame, [0, EN], [2, -2], clamp);
      transform = `scale(1.1) translate(${tx}%, ${ty}%)`;
      break;
    }
    case "diagonal-up-right": {
      const tx = interpolate(frame, [0, EN], [-2, 2], clamp);
      const ty = interpolate(frame, [0, EN], [2, -2], clamp);
      transform = `scale(1.1) translate(${tx}%, ${ty}%)`;
      break;
    }
    case "diagonal-down-left": {
      const tx = interpolate(frame, [0, EN], [2, -2], clamp);
      const ty = interpolate(frame, [0, EN], [-2, 2], clamp);
      transform = `scale(1.1) translate(${tx}%, ${ty}%)`;
      break;
    }
    case "diagonal-down-right": {
      const tx = interpolate(frame, [0, EN], [-2, 2], clamp);
      const ty = interpolate(frame, [0, EN], [-2, 2], clamp);
      transform = `scale(1.1) translate(${tx}%, ${ty}%)`;
      break;
    }
    case "slide-in-left": {
      const tx = interpolate(frame, [0, SLIDE_N], [-100, 0], clamp);
      transform = `translateX(${tx}%)`;
      break;
    }
    case "slide-in-right": {
      const tx = interpolate(frame, [0, SLIDE_N], [100, 0], clamp);
      transform = `translateX(${tx}%)`;
      break;
    }
    case "slide-in-top": {
      const ty = interpolate(frame, [0, SLIDE_N], [-100, 0], clamp);
      transform = `translateY(${ty}%)`;
      break;
    }
    case "slide-in-bottom": {
      const ty = interpolate(frame, [0, SLIDE_N], [100, 0], clamp);
      transform = `translateY(${ty}%)`;
      break;
    }
    default:
      break;
  }

  // Overlay position/scale: posX/posY are % offsets from center, overlayScale is 0..2 (default 1 = full screen)
  const overlayScale: number = clip.overlayScale ?? 1;
  const posX: number = clip.overlayX ?? 0;
  const posY: number = clip.overlayY ?? 0;

  const containerStyle: React.CSSProperties = overlayScale < 0.999
    ? {
        position: "absolute",
        width: `${overlayScale * 100}%`,
        height: `${overlayScale * 100}%`,
        top: "50%",
        left: "50%",
        transform: `translate(calc(-50% + ${posX}%), calc(-50% + ${posY}%))`,
        overflow: "hidden",
      }
    : { position: "absolute", inset: 0, overflow: "hidden" };

  const mediaStyle: React.CSSProperties = {
    width: "100%", height: "100%", objectFit: "cover", display: "block",
    transform, transformOrigin: "center center",
  };

  if (!clip.url?.startsWith("http")) return null;

  if (clip.type === "video") {
    return (
      <div style={containerStyle}>
        <OffthreadVideo src={clip.url} style={{ ...mediaStyle, position: "absolute", inset: 0 }} />
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <Img src={clip.url} style={mediaStyle} />
    </div>
  );
}

export const ShortComposition = ({
  videoUrl,
  croppedVideoUrl,
  startTime,
  endTime,
  captions,
  captionStyle = DEFAULT_CAPTION_STYLE,
  showWatermark = false,
  extraTracks,
}: any) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();

  // Ensure numeric types (Lambda passes them as strings sometimes)
  const st = Number(startTime ?? 0);
  const et = Number(endTime ?? 4);
  const durationInFrames = Math.max(1, Math.ceil((et - st) * fps));

  const src = (croppedVideoUrl?.startsWith("http") ? croppedVideoUrl : null) || (videoUrl?.startsWith("http") ? videoUrl : null) || "";
  const fromFrame = croppedVideoUrl?.startsWith("http") ? 0 : Math.floor(st * fps);
  const toFrame = croppedVideoUrl?.startsWith("http") ? durationInFrames : Math.ceil(et * fps);
  const currentTime = st + frame / fps;

  const style = { ...DEFAULT_CAPTION_STYLE, ...captionStyle };
  const batchSize = (style as CaptionStyle).wordsPerBatch || 3;
  const posBottom = (style as CaptionStyle).positionBottom ?? 10;
  const layout = (style as CaptionStyle).layout ?? "inline";

  const activeBg = (() => {
    const opacity = (style as CaptionStyle).bgOpacity;
    if (opacity === 0) return "transparent";
    const bg = style.backgroundColor;
    if (!bg || bg === "transparent") return "transparent";
    if (opacity !== undefined && opacity < 1 && bg.startsWith("#")) return hexToRgba(bg, opacity);
    return bg;
  })();

  const hasWordBg = activeBg !== "transparent";

  let activeGroup: { words: any[]; start: number; end: number } | null = null;
  if (captions) {
    let parsedCaptions = captions;
    if (typeof captions === "string") {
      try { parsedCaptions = JSON.parse(captions); } catch { parsedCaptions = []; }
    }
    // Captions store absolute timestamps from processVideo; currentTime = st + frame/fps
    // is also absolute, so no normalization needed regardless of croppedVideoUrl.
    const normalizedCaptions = parsedCaptions;
    const groups: { words: any[]; start: number; end: number }[] = [];
    for (let i = 0; i < normalizedCaptions.length; i += batchSize) {
      const chunk = normalizedCaptions.slice(i, i + batchSize);
      if (!chunk[0]) continue;
      groups.push({ words: chunk, start: chunk[0].start, end: chunk[chunk.length - 1].end });
    }
    activeGroup = groups.find((g) => currentTime >= g.start && currentTime <= g.end) || null;
  }

  // Parse extra tracks (may arrive as JSON string from Lambda inputProps)
  const parsedExtraTracks: any[] = (() => {
    if (!extraTracks) return [];
    if (typeof extraTracks === "string") {
      try { return JSON.parse(extraTracks); } catch { return []; }
    }
    return Array.isArray(extraTracks) ? extraTracks : [];
  })();

  return (
    <AbsoluteFill className="bg-black">
      {/* Main video */}
      <Sequence from={0} durationInFrames={durationInFrames}>
        <div style={{ position: "absolute", inset: 0 }}>
          {src ? (
            <OffthreadVideo
              src={src}
              startFrom={fromFrame}
              endAt={toFrame}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <AbsoluteFill style={{ backgroundColor: "#000" }} />
          )}
        </div>
      </Sequence>

      {/* Extra tracks rendered on top of base video (reversed so track[0] is topmost) */}
      {[...parsedExtraTracks].reverse().map((track: any) =>
        track.visible !== false && Array.isArray(track.clips)
          ? track.clips.map((clip: any) => (
              <Sequence key={clip.id} from={clip.startFrame ?? 0} durationInFrames={Math.max(1, clip.durationFrames ?? 30)}>
                <ExtraClipLayer clip={clip} />
              </Sequence>
            ))
          : null
      )}

      {/* Captions */}
      {activeGroup && !(style as CaptionStyle).disabled && (
        <AbsoluteFill>
          <div style={{
            position: "absolute",
            bottom: `${posBottom}%`,
            left: 80,
            right: 80,
            display: "flex",
            flexWrap: layout === "stacked" ? "nowrap" : "wrap",
            flexDirection: layout === "stacked" ? "column" : "row",
            justifyContent: "center",
            alignItems: "center",
            gap: layout === "stacked" ? 12 : 20,
          }}>
            {activeGroup.words.map((w: any, i: number) => {
              const isActive = currentTime >= w.start && currentTime <= w.end;
              return (
                <span key={i} style={{
                  display: "inline-block",
                  fontSize: isActive ? `${(style.fontSize || 88) * 1.2}px` : `${style.fontSize}px`,
                  lineHeight: "1",
                  fontFamily: style.fontFamily || "inherit",
                  fontWeight: style.fontWeight,
                  textTransform: style.textTransform,
                  color: isActive ? style.color : style.inactiveColor,
                  backgroundColor: hasWordBg
                    ? (isActive ? activeBg : (style.inactiveBackgroundColor && style.inactiveBackgroundColor !== "transparent" ? style.inactiveBackgroundColor : activeBg))
                    : undefined,
                  padding: hasWordBg ? style.padding : undefined,
                  borderRadius: hasWordBg ? `${style.borderRadius}px` : undefined,
                  transform: isActive ? "scale(1.1)" : "scale(1)",
                  opacity: isActive ? 1 : 0.6,
                  boxShadow: hasWordBg && isActive ? "0 4px 12px rgba(0,0,0,0.3)" : "none",
                  textShadow: !hasWordBg ? (style.textShadow || undefined) : undefined,
                  zIndex: isActive ? 10 : 1,
                }}>
                  {w.text || w.punctuated_word || w.word}
                </span>
              );
            })}
          </div>
        </AbsoluteFill>
      )}

      {/* Watermark for free users */}
      {showWatermark && (
        <WatermarkOverlay frame={frame} totalFrames={durationInFrames} fps={fps} />
      )}
    </AbsoluteFill>
  );
};
