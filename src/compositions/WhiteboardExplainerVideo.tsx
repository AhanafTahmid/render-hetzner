import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  interpolate,
  useCurrentFrame,
  continueRender,
  delayRender,
  CalculateMetadataFunction,
} from "remotion";
import {
  ANNOTATION_FADE_FRAMES,
  ANNOTATION_HOLD_FRAMES,
  MARKER_DOT_COLOR,
} from "../whiteboard-config";
import type {
  WbTutorConfig,
  WbSection,
  WbAnnotation,
  WbBoard,
  WbCursorWaypoint,
  Box,
} from "../whiteboard-config";

/**
 * Whiteboard Explainer composition — distilbook-style cropped reveals.
 *
 * Each cropped section image pops in at its own (x, y) placement exactly when
 * the narrator explains it, STAYS on screen for the rest of the video, and the
 * marker pen travels to it and draws its annotation (underline / circle /
 * square / marking) hugging the crop, word-synced. It reads a `WbTutorConfig`
 * manifest either directly (`whiteboardConfig`, editor Player) or by fetching
 * `dataUrl` (Studio / Lambda).
 *
 * LEGACY configs WITH a `board` keep the old whole-board sketch model (board
 * drawn during the intro, one mark on screen at a time, auto-erased).
 */

export interface WhiteboardExplainerProps extends Record<string, unknown> {
  whiteboardConfig?: WbTutorConfig | null;
  dataUrl?: string | null;
  voiceoverVolume?: number;
  musicUrl?: string | null;
  musicVolume?: number;
  showWatermark?: boolean;
  /** Editor position overrides, keyed by section id. */
  sectionPlacements?: Record<number, Box> | null;
}

const FALLBACK: WbTutorConfig = {
  metadata: { width: 1280, height: 720, fps: 30, totalFrames: 150, totalDuration: 5, bgColor: "#ffffff", aspectRatio: "16:9" },
  audio: { url: "" },
  infographic: { url: "", width: 1280, height: 720 },
  sections: [],
  annotations: [],
  cursor: { waypoints: [] },
};

// Ease-in-out (smoothstep). Used both for a section's reveal and for the pen's
// travel between sections, so nothing on screen moves at a constant, robotic
// speed — it accelerates away and settles gently.
const smooth = (t: number): number => t * t * (3 - 2 * t);

function placementFor(s: WbSection, overrides?: Record<number, Box> | null): Box {
  return overrides?.[s.id] ?? s.placement;
}

// ─── Board: hand-draw the whole infographic onto the canvas ─────────────────

/**
 * Reveal the content-cropped infographic ("board") top-to-bottom over
 * [0, drawEnd], as if a hand were sketching it in. The `HandCursor` rides the
 * reveal frontier. After `drawEnd` the whole board stays on screen.
 */
const BoardDraw: React.FC<{ board: WbBoard; drawEnd: number }> = ({ board, drawEnd }) => {
  const frame = useCurrentFrame();
  const p = drawEnd > 0 ? Math.min(1, frame / drawEnd) : 1;
  const hidePct = (1 - p) * 100;
  const r = board.rect;
  return (
    <Img
      src={board.url}
      pauseWhenLoading
      style={{
        position: "absolute",
        left: r.x,
        top: r.y,
        width: r.w,
        height: r.h,
        objectFit: "fill",
        clipPath: `inset(0 0 ${hidePct}% 0)`,
        WebkitClipPath: `inset(0 0 ${hidePct}% 0)`,
      }}
    />
  );
};

/**
 * One cropped section image revealing at its placement 0.2s before its
 * narration sentence starts (see WB_REVEAL_LEAD_SECONDS) — left-to-right wipe
 * for drawn content, fade for photos — then staying on screen for the rest of
 * the video (endFrame ends the ANIMATION, not the image; the board fills up as
 * the audio talks).
 *
 * The reveal is eased and carries a short fade + settle so a group of crops
 * glides in together instead of snapping on: at the sentence's first word the
 * images are already ~half-way in, which is what reads as "smooth".
 */
const SectionReveal: React.FC<{ section: WbSection; box: Box }> = ({ section, box }) => {
  const frame = useCurrentFrame();
  if (frame < section.startFrame) return null;
  const raw = interpolate(frame, [section.startFrame, section.endFrame], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const p = smooth(raw); // ease-in-out
  const clipPath = section.revealStyle === "fade" ? undefined : `inset(0 ${(1 - p) * 100}% 0 0)`;
  // opacity/scale settle runs faster than the wipe so the shape is solid early
  const settle = Math.min(1, raw * 2.5);
  const opacity = section.revealStyle === "fade" ? p : smooth(settle);
  const scale = 0.985 + 0.015 * smooth(settle);
  // Line art is drawn from its VTracer trace when one exists: transparent
  // `#000000` geometry with no background rect (see `lib/.../vectorize.ts`), so
  // it stays crisp at any scale and cannot occlude what is already on the board.
  const src = section.svgUrl ?? section.imageUrl;
  return (
    <Img
      src={src}
      pauseWhenLoading
      style={{
        position: "absolute",
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        objectFit: "fill",
        clipPath,
        WebkitClipPath: clipPath,
        opacity,
        transform: `scale(${scale})`,
        transformOrigin: "center center",
        // Crops are cut a few pixels wide of their ink so a reveal can't shave
        // its own edge, which means neighbouring crops OVERLAP. Isolated crops
        // carry a real alpha channel — their background and any sliver of the
        // neighbour are already gone — so they compose normally. LEGACY configs
        // ship opaque rectangles whose page-white would paint over the earlier
        // crop's ink (this is what used to clip captions, "U19 WORLD CUP FI…");
        // multiply makes white transparent on a white board, so keep it for them.
        mixBlendMode: section.isolated || section.svgUrl ? "normal" : "multiply",
      }}
    />
  );
};

// ─── Annotation: underline / circle / square / marking drawn on cue ─────────

const strokeSvgStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  pointerEvents: "none",
};

const AnnotationStroke: React.FC<{ ann: WbAnnotation; clearFrame: number }> = ({ ann, clearFrame }) => {
  const frame = useCurrentFrame();
  // Appears on cue; `clearFrame` erases it — 0.4s after the stroke finishes, so
  // only the part currently being narrated carries a mark.
  if (frame < ann.startFrame || frame >= clearFrame) return null;
  const p = interpolate(frame, [ann.startFrame, ann.endFrame], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  // dissolve over the last few frames instead of blinking off
  const fade = interpolate(frame, [clearFrame - ANNOTATION_FADE_FRAMES, clearFrame], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  if (ann.type === "underline" || ann.type === "marking") {
    const from = ann.geometry.from as { x: number; y: number };
    const to = ann.geometry.to as { x: number; y: number };
    const x2 = from.x + (to.x - from.x) * p;
    const y2 = from.y + (to.y - from.y) * p;
    return (
      <svg style={strokeSvgStyle} opacity={fade}>
        <line x1={from.x} y1={from.y} x2={x2} y2={y2} stroke={ann.color} strokeWidth={5} strokeLinecap="round" />
      </svg>
    );
  }

  if (ann.type === "square") {
    // Rect outline swept clockwise from the top-left; pathLength normalises the
    // dash sweep to 0→1 regardless of the rect's actual perimeter.
    const path = (ann.geometry.path as Array<{ x: number; y: number }>) ?? [];
    if (path.length < 2) return null;
    return (
      <svg style={strokeSvgStyle} opacity={fade}>
        <polyline
          points={path.map((pt) => `${pt.x},${pt.y}`).join(" ")}
          fill="none"
          stroke={ann.color}
          strokeWidth={5}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - p}
        />
      </svg>
    );
  }

  // circle: sweep the ellipse outline
  const cx = ann.geometry.cx as number;
  const cy = ann.geometry.cy as number;
  const r = ann.geometry.radius as number;
  const circumference = 2 * Math.PI * r;
  return (
    <svg style={strokeSvgStyle} opacity={fade}>
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={ann.color}
        strokeWidth={5}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - p)}
        transform={`rotate(-90 ${cx} ${cy})`}
      />
    </svg>
  );
};

// ─── Marker pen cursor following the waypoints ──────────────────────────────

/**
 * Position of the pen nib at `frame`, interpolating along the cursor waypoints.
 * TRAVELING segments (moving from one element to the next) are eased so the pen
 * glides; DRAWING segments (riding a stroke) stay linear so the nib tracks the
 * ink exactly.
 */
function cursorAt(waypoints: WbCursorWaypoint[], frame: number): { x: number; y: number } | null {
  if (waypoints.length === 0) return null;
  if (frame <= waypoints[0].frame) return waypoints[0];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    if (frame >= a.frame && frame <= b.frame) {
      const raw = b.frame === a.frame ? 1 : (frame - a.frame) / (b.frame - a.frame);
      const t = b.state === "traveling" ? smooth(raw) : raw;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
  }
  return waypoints[waypoints.length - 1];
}

/** Ink colour of the mark the pen is currently on / heading toward, for its nib. */
function activeColorAt(annotations: WbAnnotation[], frame: number): string {
  if (annotations.length === 0) return "#1f2937";
  let current = annotations[0];
  for (const a of annotations) {
    if (a.startFrame <= frame) current = a; // the most recently started mark
  }
  return current.color;
}

/**
 * The pointer: a soft orange DOT sitting exactly on the point of the board
 * being highlighted (distilbook's "Dot" pointer), drawn as geometry — no image
 * asset — so it renders identically in the browser preview and a Lambda render.
 *
 * It's a filled dot with a translucent halo around it; `pressed` (the pen is
 * actually laying down ink, vs travelling between marks) swells the halo, so
 * the highlight reads as the dot pressing onto the board.
 */
const MarkerDot: React.FC<{ x: number; y: number; color: string; scale?: number; pressed?: boolean }> = ({
  x,
  y,
  color,
  scale = 1,
  pressed = false,
}) => {
  const r = 7 * scale;
  const halo = (pressed ? 2.6 : 2.0) * r;
  return (
    <svg
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}
    >
      <g transform={`translate(${x} ${y})`}>
        <circle r={halo} fill={color} opacity={pressed ? 0.22 : 0.14} />
        <circle r={r} fill={color} />
        {/* tiny highlight so the dot reads as a physical tip, not a flat disc */}
        <circle cx={-r * 0.3} cy={-r * 0.3} r={r * 0.32} fill="rgba(255,255,255,0.55)" />
      </g>
    </svg>
  );
};

/**
 * The pointer dot. It glides (eased) from one highlighted part to the next and
 * rides each stroke exactly as it's drawn, swelling while it lays down ink.
 * It appears only when there's something to point at: it's hidden before the
 * first mark and after the last one has been erased.
 *
 * LEGACY board configs keep the draw-phase behaviour — riding the board's
 * reveal frontier side-to-side as the sketch fills in.
 */
const MarkerCursor: React.FC<{ cfg: WbTutorConfig; drawEnd: number }> = ({ cfg, drawEnd }) => {
  const frame = useCurrentFrame();
  const { height } = cfg.metadata;
  const board = cfg.board;

  let tip: { x: number; y: number } | null;
  if (board && frame <= drawEnd) {
    // LEGACY: riding the drawing frontier as the board reveals top-to-bottom.
    const p = drawEnd > 0 ? frame / drawEnd : 1;
    tip = {
      x: board.rect.x + board.rect.w * (0.5 + 0.32 * Math.sin(frame * 0.45)),
      y: board.rect.y + p * board.rect.h,
    };
  } else {
    const waypoints = cfg.cursor.waypoints;
    if (!board && waypoints.length > 0) {
      // only exists between setting out for the first mark and the last mark
      // finishing its hold — it never idles on a blank board.
      const lastMarkGone = cfg.annotations.reduce((m, a) => Math.max(m, a.endFrame), 0) + ANNOTATION_HOLD_FRAMES;
      if (frame < waypoints[0].frame || frame > lastMarkGone) return null;
    }
    tip = cursorAt(waypoints, frame);
  }
  if (!tip) return null;

  // Scale the dot to the canvas so it reads at any resolution.
  const scale = height / 720;
  const color = board ? activeColorAt(cfg.annotations, frame) : MARKER_DOT_COLOR;
  // "pressed" while a stroke is actually being laid down
  const pressed = cfg.annotations.some((a) => frame >= a.startFrame && frame <= a.endFrame);
  return <MarkerDot x={tip.x} y={tip.y} color={color} scale={scale} pressed={pressed} />;
};

// ─── Main composition ───────────────────────────────────────────────────────

export const WhiteboardExplainerVideo: React.FC<WhiteboardExplainerProps> = (props) => {
  const cfg = props.whiteboardConfig ?? FALLBACK;
  const { metadata, sections, annotations, audio, board } = cfg;

  // LEGACY board configs: draw phase ends when the first section gets marked
  // (or an explicit override).
  const firstMark = annotations.reduce((m, a) => Math.min(m, a.startFrame), metadata.totalFrames);
  const drawEnd = metadata.drawEndFrame ?? (board ? firstMark : 0);

  // A mark holds for 0.4s after it finishes drawing, then fades out — the ink
  // never accumulates, so at any moment only the part being narrated is
  // highlighted. It also clears early if the next mark starts sooner than that.
  // LEGACY board configs keep the old behavior (erased when the marker moves on).
  const markStarts = annotations.map((a) => a.startFrame).sort((x, y) => x - y);
  // Frames at which a LATER section begins appearing — a sentence-owning
  // highlight lets go here rather than waiting for the next mark to be drawn,
  // which would leave the old panel lit well into the new sentence.
  const sectionStarts = sections.map((s) => s.startFrame).sort((x, y) => x - y);
  const clearFrameFor = (ann: WbAnnotation): number => {
    const next = markStarts.find((f) => f > ann.startFrame) ?? metadata.totalFrames;
    if (board) return next;
    // A mark that owns its whole sentence stays lit for that sentence and clears
    // as the NEXT section arrives on screen — the highlight moves with the voice.
    if (ann.holdUntilNext) {
      const nextSection = sectionStarts.find((f) => f > ann.startFrame) ?? metadata.totalFrames;
      return Math.max(ann.endFrame, Math.min(next, nextSection));
    }
    // Marks that share a sentence take turns: hold briefly, then fade.
    return Math.min(next, ann.endFrame + ANNOTATION_HOLD_FRAMES);
  };

  return (
    <AbsoluteFill style={{ backgroundColor: metadata.bgColor }}>
      {board ? (
        <BoardDraw board={board} drawEnd={drawEnd} />
      ) : (
        sections.map((s) => (
          <SectionReveal key={s.id} section={s} box={placementFor(s, props.sectionPlacements)} />
        ))
      )}
      {annotations.map((a) => (
        <AnnotationStroke key={a.id} ann={a} clearFrame={clearFrameFor(a)} />
      ))}
      <MarkerCursor cfg={cfg} drawEnd={drawEnd} />

      {audio.url ? <Audio src={audio.url} volume={props.voiceoverVolume ?? 1} pauseWhenBuffering /> : null}
      {props.musicUrl ? <Audio src={props.musicUrl} volume={props.musicVolume ?? 0.12} pauseWhenBuffering /> : null}

      {props.showWatermark ? (
        <div
          style={{
            position: "absolute",
            right: 16,
            bottom: 12,
            fontSize: 18,
            fontWeight: 700,
            color: "rgba(0,0,0,0.35)",
          }}
        >
          vidgpt
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

// ─── Metadata: read the config from props or fetch dataUrl ──────────────────

export const calculateWhiteboardExplainerMetadata: CalculateMetadataFunction<WhiteboardExplainerProps> = async ({
  props,
}) => {
  let cfg = props.whiteboardConfig;
  if (!cfg && props.dataUrl) {
    const handle = delayRender("fetch whiteboard config");
    try {
      const res = await fetch(props.dataUrl);
      cfg = (await res.json()) as WbTutorConfig;
    } catch {
      cfg = FALLBACK;
    } finally {
      continueRender(handle);
    }
  }
  const m = (cfg ?? FALLBACK).metadata;
  return {
    durationInFrames: Math.max(m.fps, m.totalFrames),
    fps: m.fps,
    width: m.width,
    height: m.height,
  };
};

export default WhiteboardExplainerVideo;
