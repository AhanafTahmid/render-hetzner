"use client";

import React, { useMemo } from "react";
import { AbsoluteFill, Audio, Sequence, useCurrentFrame } from "remotion";

// ── Template layout registries ─────────────────────────────────────────────────
import { LAYOUT_REGISTRY } from "../remotion/templates/default/layouts";
import { NIGHTFALL_LAYOUT_REGISTRY } from "../remotion/templates/nightfall/layouts";
import { GRIDCRAFT_LAYOUT_REGISTRY } from "../remotion/templates/gridcraft/layouts";
import { SPOTLIGHT_LAYOUT_REGISTRY } from "../remotion/templates/spotlight/layouts";
import { WHITEBOARD_LAYOUT_REGISTRY } from "../remotion/templates/whiteboard/layouts";
import { NEWSPAPER_LAYOUT_REGISTRY } from "../remotion/templates/newspaper/layouts";
import { MATRIX_LAYOUT_REGISTRY } from "../remotion/templates/matrix/layouts";
import { NEWSCAST_LAYOUT_REGISTRY } from "../remotion/templates/newscast/layouts";
import { MOSAIC_LAYOUT_REGISTRY } from "../remotion/templates/mosaic/layouts";
import { BLACKSWAN_LAYOUT_REGISTRY } from "../remotion/templates/blackswan/layouts";
import { BLOOMBERG_LAYOUT_REGISTRY } from "../remotion/templates/bloomberg/layouts";
import { CHRONICLE_LAYOUT_REGISTRY } from "../remotion/templates/chronicle/layouts";

import { SceneDurationInFramesContext } from "../remotion/components/SceneDurationContext";

const FPS = 30;

// ── Per-template defaults ──────────────────────────────────────────────────────

interface TemplateConfig {
  accentColor: string;
  bgColor: string;
  textColor: string;
  registry: Record<string, React.FC<any>>;
}

const TEMPLATE_CONFIG: Record<string, TemplateConfig> = {
  default: {
    accentColor: "#7C3AED",
    bgColor: "#FFFFFF",
    textColor: "#000000",
    registry: LAYOUT_REGISTRY as Record<string, React.FC<any>>,
  },
  "geometric-explainer": {
    accentColor: "#7C3AED",
    bgColor: "#FFFFFF",
    textColor: "#000000",
    registry: LAYOUT_REGISTRY as Record<string, React.FC<any>>,
  },
  nightfall: {
    accentColor: "#818CF8",
    bgColor: "#0A0A1A",
    textColor: "#E2E8F0",
    registry: NIGHTFALL_LAYOUT_REGISTRY as Record<string, React.FC<any>>,
  },
  gridcraft: {
    accentColor: "#F97316",
    bgColor: "#FAFAFA",
    textColor: "#171717",
    registry: GRIDCRAFT_LAYOUT_REGISTRY as Record<string, React.FC<any>>,
  },
  spotlight: {
    accentColor: "#EF4444",
    bgColor: "#000000",
    textColor: "#FFFFFF",
    registry: SPOTLIGHT_LAYOUT_REGISTRY as Record<string, React.FC<any>>,
  },
  whiteboard: {
    accentColor: "#1F2937",
    bgColor: "#F7F3E8",
    textColor: "#111827",
    registry: WHITEBOARD_LAYOUT_REGISTRY as Record<string, React.FC<any>>,
  },
  newspaper: {
    accentColor: "#FFE34D",
    bgColor: "#FAFAF8",
    textColor: "#111111",
    registry: NEWSPAPER_LAYOUT_REGISTRY as Record<string, React.FC<any>>,
  },
  matrix: {
    accentColor: "#00FF41",
    bgColor: "#000000",
    textColor: "#00FF41",
    registry: MATRIX_LAYOUT_REGISTRY as Record<string, React.FC<any>>,
  },
  newscast: {
    accentColor: "#E82020",
    bgColor: "#060614",
    textColor: "#B8C8E0",
    registry: NEWSCAST_LAYOUT_REGISTRY as Record<string, React.FC<any>>,
  },
  mosaic: {
    accentColor: "#C26240",
    bgColor: "#EAE4DA",
    textColor: "#2A2A28",
    registry: MOSAIC_LAYOUT_REGISTRY as Record<string, React.FC<any>>,
  },
  blackswan: {
    accentColor: "#00E5FF",
    bgColor: "#000000",
    textColor: "#DFFFFF",
    registry: BLACKSWAN_LAYOUT_REGISTRY as Record<string, React.FC<any>>,
  },
  bloomberg: {
    accentColor: "#5EA2FF",
    bgColor: "#000000",
    textColor: "#FFB340",
    registry: BLOOMBERG_LAYOUT_REGISTRY as Record<string, React.FC<any>>,
  },
  chronicle: {
    accentColor: "#B8860B",
    bgColor: "#F1E4C9",
    textColor: "#2A1810",
    registry: CHRONICLE_LAYOUT_REGISTRY as Record<string, React.FC<any>>,
  },
};

// ── Prop converters per template ──────────────────────────────────────────────

function convertNightfallProps(lp: Record<string, unknown>): Record<string, unknown> {
  const out = { ...lp };
  if (Array.isArray(out.barChartRows)) {
    const rows = out.barChartRows as { label?: string; value?: string }[];
    out.barChart = {
      labels: rows.map((r) => (r?.label != null ? String(r.label) : "")),
      values: rows.map((r) => (r?.value != null && r.value !== "" ? Number(r.value) || 0 : 0)),
    };
    delete out.barChartRows;
  }
  if (Array.isArray(out.pieChartRows)) {
    const rows = out.pieChartRows as { label?: string; value?: string }[];
    out.pieChart = {
      labels: rows.map((r) => (r?.label != null ? String(r.label) : "")),
      values: rows.map((r) => (r?.value != null && r.value !== "" ? Number(r.value) || 0 : 0)),
    };
    delete out.pieChartRows;
  }
  if (Array.isArray(out.lineChartLabels) && Array.isArray(out.lineChartDatasets)) {
    const labels = (out.lineChartLabels as string[]).map((l) => (l != null ? String(l) : ""));
    const datasets = (out.lineChartDatasets as { label?: string; valuesStr?: string }[]).map((d) => ({
      label: String(d?.label ?? ""),
      values: String(d?.valuesStr ?? "").split(",").map((s) => Number(s.trim()) || 0),
    }));
    out.lineChart = { labels, datasets };
    delete out.lineChartLabels;
    delete out.lineChartDatasets;
  }
  return out;
}

function convertNewscastProps(lp: Record<string, unknown>): Record<string, unknown> {
  const out = { ...lp };
  const barChart = out.barChart as { labels?: unknown[]; values?: unknown[] } | undefined;
  if (!out.barChartRows && barChart && typeof barChart === "object") {
    const labels = Array.isArray(barChart.labels) ? barChart.labels : [];
    const values = Array.isArray(barChart.values) ? barChart.values : [];
    out.barChartRows = labels.map((label, index) => ({
      label: String(label ?? ""),
      value: String(values[index] ?? ""),
    }));
  }
  return out;
}

function normalizeLayoutProps(themeId: string, lp: Record<string, unknown>): Record<string, unknown> {
  if (themeId === "nightfall") return convertNightfallProps(lp);
  if (themeId === "newscast") return convertNewscastProps(lp);
  return lp;
}

// ── Captions overlay ──────────────────────────────────────────────────────────

interface CaptionWord {
  start: number;
  end: number;
  text: string;
}

interface CaptionStyleInput {
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  activeColor?: string;
  inactiveColor?: string;
  positionBottom?: number;
  wordsPerBatch?: number;
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  layout?: "inline" | "stacked";
  captionBgColor?: string;
  captionBgOpacity?: number;
}

function CaptionsOverlay({
  captions,
  captionStyle: cs,
}: {
  captions: CaptionWord[];
  captionStyle?: CaptionStyleInput;
}) {
  const frame = useCurrentFrame();
  const fps = FPS;

  const fontSize = cs?.fontSize ?? 72;
  const fontWeight = cs?.fontWeight ?? 700;
  const fontFamily = cs?.fontFamily ?? "system-ui";
  const activeColor = cs?.activeColor ?? "#FFFFFF";
  const inactiveColor = cs?.inactiveColor ?? "#9CA3AF";
  const positionBottom = cs?.positionBottom ?? 5;
  const wordsPerBatch = cs?.wordsPerBatch ?? 1;
  const textTransform = cs?.textTransform ?? "none";
  const isStacked = cs?.layout === "stacked";
  const bgColor = cs?.captionBgColor ?? "#000000";
  const bgOpacity = cs?.captionBgOpacity ?? 0;

  const currentTimeMs = (frame / fps) * 1000;

  function transformText(t: string) {
    if (textTransform === "uppercase") return t.toUpperCase();
    if (textTransform === "lowercase") return t.toLowerCase();
    if (textTransform === "capitalize") return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
    return t;
  }

  let activeIdx = captions.findIndex((w) => w.start <= currentTimeMs && w.end >= currentTimeMs);
  if (activeIdx === -1) {
    for (let i = captions.length - 1; i >= 0; i--) {
      if (captions[i].start <= currentTimeMs) {
        const batchIdx = Math.floor(i / wordsPerBatch);
        const nextBatchFirstWord = captions[(batchIdx + 1) * wordsPerBatch];
        if (!nextBatchFirstWord || nextBatchFirstWord.start > currentTimeMs) {
          activeIdx = i;
        }
        break;
      }
    }
  }

  if (activeIdx === -1) return null;

  const batchStart = Math.floor(activeIdx / wordsPerBatch) * wordsPerBatch;
  const batchEnd = Math.min(captions.length, batchStart + wordsPerBatch);
  const words = captions.slice(batchStart, batchEnd).map((w, i) => ({
    text: w.text,
    isActive: batchStart + i === activeIdx,
  }));

  const hasBg = bgOpacity > 0;
  const r = parseInt(bgColor.slice(1, 3), 16) || 0;
  const g = parseInt(bgColor.slice(3, 5), 16) || 0;
  const b = parseInt(bgColor.slice(5, 7), 16) || 0;
  const bgStyle = hasBg ? `rgba(${r},${g},${b},${bgOpacity})` : "transparent";

  return (
    <AbsoluteFill
      style={{
        top: undefined,
        bottom: `${positionBottom}%`,
        height: "auto",
        justifyContent: "center",
        alignItems: "stretch",
        flexDirection: "column",
        textAlign: "center",
        width: "100%",
        padding: "0 20px",
        boxSizing: "border-box",
        pointerEvents: "none",
        zIndex: 100,
      }}
    >
      <div style={{ width: "100%", textAlign: "center" }}>
        <div
          style={{
            display: "inline-block",
            maxWidth: "100%",
            padding: hasBg ? "8px 16px" : "0",
            borderRadius: hasBg ? 8 : 0,
            backgroundColor: bgStyle,
          }}
        >
          {words.map(({ text, isActive }, idx) => (
            <span
              key={idx}
              style={{
                color: isActive ? activeColor : inactiveColor,
                fontSize: isActive ? `calc(${fontSize}px * 1.06)` : `${fontSize}px`,
                fontWeight,
                fontFamily,
                textShadow: hasBg
                  ? "none"
                  : isActive
                  ? "2px 2px 8px rgba(0,0,0,0.9), 0 0 20px rgba(0,0,0,0.5)"
                  : "1px 1px 4px rgba(0,0,0,0.7)",
                display: isStacked ? "block" : "inline",
              }}
            >
              {transformText(text)}
              {!isStacked && idx < words.length - 1 ? " " : ""}
            </span>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface BlogTemplatePlayerProps extends Record<string, unknown> {
  script?: any[];
  audioFileUrl?: string;
  musicUrl?: string;
  voiceoverVolume?: number;
  musicVolume?: number;
  captions?: CaptionWord[];
  imageList?: string[];
  clipDurations?: number[];
  voiceoverSegments?: any[];
  showWatermark?: boolean;
  captionStyle?: CaptionStyleInput;
  captionsVisible?: boolean;
  themeId?: string;
  // Custom-theme overrides: reuse `themeId`'s layouts but recolor to a brand.
  accentColorOverride?: string;
  bgColorOverride?: string;
  textColorOverride?: string;
  fontFamilyOverride?: string;
  /** Bakes a playback speed into the video: scenes, audio and captions are all scaled. */
  playbackRate?: number;
}

export function BlogTemplatePlayer({
  script = [],
  audioFileUrl,
  musicUrl,
  voiceoverVolume = 1,
  musicVolume = 0.35,
  captions = [],
  imageList = [],
  clipDurations,
  voiceoverSegments,
  captionStyle,
  captionsVisible = true,
  themeId = "whiteboard",
  accentColorOverride,
  bgColorOverride,
  textColorOverride,
  fontFamilyOverride,
  playbackRate = 1,
}: BlogTemplatePlayerProps) {
  const config = TEMPLATE_CONFIG[themeId] ?? TEMPLATE_CONFIG.whiteboard;
  const registry = config.registry;
  const accentColor = accentColorOverride || config.accentColor;
  const bgColor = bgColorOverride || config.bgColor;
  const textColor = textColorOverride || config.textColor;
  const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;

  // Build per-scene timings from clipDurations or voiceoverSegments.
  // Durations are divided by `rate` so a higher speed produces a shorter video.
  const sceneTimings = useMemo(() => {
    const segMap: Record<number, number> = {};
    for (const seg of voiceoverSegments ?? []) {
      if (seg.durationSecs > 0) segMap[seg.scriptIndex] = seg.durationSecs;
    }
    let offset = 0;
    return script.map((_, i) => {
      const secs = clipDurations?.[i] ?? segMap[i] ?? 5;
      const frames = Math.max(1, Math.round((secs * FPS) / rate));
      const start = offset;
      offset += frames;
      return { startFrame: start, durationFrames: frames };
    });
  }, [script, clipDurations, voiceoverSegments, rate]);

  // Scale caption timings to match the sped-up scenes.
  const scaledCaptions = useMemo(
    () => (rate === 1 ? captions : captions.map((c) => ({ ...c, start: c.start / rate, end: c.end / rate }))),
    [captions, rate],
  );

  // Build a lookup for voiceover segments by scene index
  const segByIndex = useMemo(() => {
    const map: Record<number, { audioUrl: string; durationSecs: number }> = {};
    for (const seg of voiceoverSegments ?? []) {
      map[seg.scriptIndex] = seg;
    }
    return map;
  }, [voiceoverSegments]);

  const firstLayoutKey = Object.keys(registry)[0] ?? "";

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor, overflow: "hidden", ...(fontFamilyOverride ? { fontFamily: fontFamilyOverride } : {}) }}>
      {script.map((scene, i) => {
        const { startFrame, durationFrames } = sceneTimings[i] ?? { startFrame: 0, durationFrames: FPS * 5 };
        const layoutId: string = scene.layout ?? firstLayoutKey;
        const LayoutComponent = registry[layoutId] ?? registry[firstLayoutKey];
        if (!LayoutComponent) return null;

        const rawProps = (scene.layoutProps && typeof scene.layoutProps === "object")
          ? (scene.layoutProps as Record<string, unknown>)
          : {};
        const convertedProps = normalizeLayoutProps(themeId, rawProps);

        const imageUrl: string | undefined = imageList[i] && imageList[i].length > 0
          ? imageList[i]
          : undefined;

        const finalProps = {
          ...convertedProps,
          title: scene.title ?? "",
          // Layout components use `narration` as the ON-SCREEN body text.
          // Use displayText (formatted for screen) when available; fall back to narration.
          narration: scene.displayText ?? scene.narration ?? "",
          accentColor,
          bgColor,
          textColor,
          ...(fontFamilyOverride ? { fontFamily: fontFamilyOverride } : {}),
          aspectRatio: "landscape",
          imageUrl,
        };

        const seg = segByIndex[i];

        return (
          <Sequence key={i} from={startFrame} durationInFrames={durationFrames} name={scene.title ?? `Scene ${i + 1}`}>
            {/*
              A <Sequence> knows its own length but nothing inside it can read
              that back — `useVideoConfig()` reports the COMPOSITION's duration.
              `SceneMedia` needs the scene length to loop a stock clip that is
              shorter than the narration instead of parking on its last frame,
              so hand it down explicitly.
            */}
            <SceneDurationInFramesContext.Provider value={durationFrames}>
              <LayoutComponent {...finalProps} />
            </SceneDurationInFramesContext.Provider>
            {seg?.audioUrl && (
              <Audio src={seg.audioUrl} volume={voiceoverVolume} playbackRate={rate} />
            )}
          </Sequence>
        );
      })}

      {/* Fallback full-audio when no per-segment audio */}
      {(!voiceoverSegments || voiceoverSegments.length === 0) && audioFileUrl && (
        <Audio src={audioFileUrl} volume={voiceoverVolume} playbackRate={rate} />
      )}

      {musicUrl && <Audio src={musicUrl} volume={musicVolume} loop playbackRate={rate} />}

      {captionsVisible && scaledCaptions.length > 0 && (
        <CaptionsOverlay captions={scaledCaptions} captionStyle={captionStyle} />
      )}
    </AbsoluteFill>
  );
}

export default BlogTemplatePlayer;
