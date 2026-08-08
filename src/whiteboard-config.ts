/**
 * Whiteboard Explainer — service & pipeline config (the "whiteboard config").
 *
 * ONE place that names which external service handles each stage of the
 * whiteboard-explainer pipeline, plus the canvas/timing constants the whole
 * feature shares. Pure and dependency-free (no SDK imports) so both the
 * dashboard page (browser) and the Inngest worker (server) can import it.
 *
 * Distilbook-style pipeline, at a glance:
 *   source → brief (claude) → infographic (fixed image / nano-banana-pro) → sections (vision)
 *          → crop sections (sharp) → narration (claude) → audio (inworld)
 *          → word timings (assemblyai) → schedule reveals + marker → tutor_config
 *
 * See `lib/whiteboard-explainer/generate.ts` for the actual implementation
 * (every stage is a function on a single page) and `whiteboard-explainer.md`
 * for the full write-up.
 */

// ─── Which service runs each stage ──────────────────────────────────────────

/** Providers that can produce the single base infographic image. */
export type InfographicProvider =
  | "replicate-nano-banana-pro" // current primary: replicate google/nano-banana-pro
  | "nano-banana-google" // fallback: Google Gemini 2.5 Flash Image (REST), batch-capable
  | "grok-imagine" // TEST ONLY: replicate xai/grok-imagine-image
  | "upload"; // TEST ONLY: a user-uploaded image (e.g. 1.png)

/**
 * The service map. This is the answer to "which service is used for each?".
 * `infographic.primary` is tried first; on error/empty output the pipeline
 * falls back to `infographic.fallback`. The two `test` providers are only
 * reachable from the (temporary) dashboard Test section.
 */
export const WHITEBOARD_SERVICES = {
  brief: { service: "replicate", model: "google/gemini-2.5-flash", role: "Distill source → infographic brief" },
  infographic: {
    // Nano Banana Pro. The layout is no longer a strict grid we have to police —
    // Opus 5 slices whatever gets drawn (`sections` below) — so the thing that
    // matters is drawing fidelity: many small, distinct, cleanly-separated
    // elements with correctly-spelled labels, which is what every crop becomes.
    // Grok holds a rigid grid better but draws a poorer picture, so it is now
    // the fallback rather than the primary.
    primary: "replicate-nano-banana-pro" as InfographicProvider,
    fallback: "grok-imagine" as InfographicProvider,
    /**
     * OFF (2026-07-22): a style reference image made the boards look odd — the
     * models lean on its composition instead of the grid, and its content bleeds
     * through. The written style prompt plus the grid does the job on its own.
     *
     * Set to a public image URL to re-enable it: the plumbing is still there
     * (nano-banana takes `image_input: [url]`, Grok takes `image: url`) and
     * `WHITEBOARD_REFERENCE_GUARD` is appended to the prompt whenever it is set.
     */
    styleReferenceUrl: "",
    test: ["replicate-nano-banana-pro", "grok-imagine", "upload"] as InfographicProvider[],
    googleModel: "gemini-2.5-flash-image",
    replicateModel: "google/nano-banana-pro",
    grokModel: "xai/grok-imagine-image",
  },
  /**
   * PRIMARY slicing: ONE Claude Opus 5 call returns a bounding box for every
   * distinct visual part of the board (and which cluster it belongs to). Opus 5
   * is in the high-resolution vision tier, so returned coordinates map 1:1 to
   * the pixels we send — there is no scale-factor guesswork, which is what made
   * every earlier detector drift. Nothing else looks at the pixels: sharp cuts
   * the crops from exactly these boxes.
   */
  sections: { service: "anthropic", model: "claude-opus-5", role: "Segment the board into per-part bounding boxes + clusters (ONE call)" },
  vision: { service: "replicate", model: "google/gemini-2.5-flash", role: "LEGACY fallback slicing (Inkplainer-style ink islands + coarse boxes)" },
  crop: { service: "sharp", role: "Extract each section box → its own PNG" },
  /**
   * The script runs on Opus 5 too (`narrate-claude.ts`). Each sentence has to
   * weave its cluster's printed keywords in VERBATIM and in order — that exact
   * match is what lets a crop land on its own spoken word and the marker hug it.
   * A model that paraphrases a keyword silently un-syncs that picture.
   */
  narration: { service: "anthropic", model: "claude-opus-5", role: "Write the spoken line per section (ONE call, verbatim-keyword contract)" },
  tts: { service: "inworld", role: "Narration audio (voice per user)" },
  alignment: { service: "assemblyai", role: "Word-level timestamps to sync reveals" },
  storage: { service: "cloudflare-r2", role: "Store infographic, section crops, audio, tutor_config" },
  render: { service: "remotion", composition: "whiteboard-explainer", role: "Draw sections in + marker, export MP4" },
} as const;

/** Env var each service needs (documented here so setup is obvious). */
export const WHITEBOARD_ENV = {
  anthropic: "ANTHROPIC_API_KEY", // Opus 5: board segmentation + narration writing
  "nano-banana-google": "GEMINI_API_KEY",
  "replicate-nano-banana-pro": "REPLICATE_API_TOKEN",
  "grok-imagine": "REPLICATE_API_TOKEN",
  replicate: "REPLICATE_API_TOKEN", // brief + vision slicing run on google/gemini-2.5-flash via Replicate
  gemini: "GEMINI_API_KEY", // still used by nano-banana-google image generation
  deepseek: "DEEPSEEK_API_KEY", // narration writing runs on DeepSeek
  inworld: "INWORLD_API_KEY",
  assemblyai: "CAPTION_API_KEY",
} as const;

// ─── Canvas / timing constants ──────────────────────────────────────────────

export const WB_FPS = 30;
export const WB_WIDTH = 1280;
export const WB_HEIGHT = 720;
export const WB_ASPECT_RATIO = "16:9" as const;
export const WB_BG_COLOR = "#ffffff";

/** How long (in frames) a section takes to draw itself in (~1.4s at 30fps). */
export const REVEAL_DURATION_FRAMES = 42;
/**
 * A sentence's group of crops starts appearing this many SECONDS before the
 * narrator actually begins that sentence, so the visuals are already settling
 * in when the words land (they never pop in late/on top of the voice).
 */
export const WB_REVEAL_LEAD_SECONDS = 0.2;
/** …the same lead expressed in frames. */
export const WB_REVEAL_LEAD_FRAMES = Math.round(WB_REVEAL_LEAD_SECONDS * WB_FPS);
/**
 * …and the other end of the same window: EVERY crop in a sentence's group must
 * be fully on screen this many SECONDS before that sentence finishes. The group
 * therefore drifts in gradually across the sentence (each part landing near the
 * words that describe it) but is guaranteed complete — the whole cluster visible
 * together — before the narrator moves on to the next one.
 */
export const WB_GROUP_COMPLETE_LEAD_SECONDS = 0.6;
/** …the same tail expressed in frames. */
export const WB_GROUP_COMPLETE_LEAD_FRAMES = Math.round(WB_GROUP_COMPLETE_LEAD_SECONDS * WB_FPS);
/**
 * A crop whose keyword the narrator actually says finishes drawing this many
 * frames BEFORE the phrase starts, rather than taking its slot in the group's
 * stagger. Small on purpose: the point is that the picture has just settled as
 * its name is spoken, so the marker can highlight it on the word.
 */
export const WB_REVEAL_SETTLE_FRAMES = 5;
/**
 * How long an annotation stroke (underline/circle) takes to draw (~1.2s). Slow
 * enough to read as a deliberate highlight being laid down while the narrator
 * talks about that panel, rather than a box snapping into place.
 */
export const ANNOTATION_DURATION_FRAMES = 36;
/**
 * A mark stays on screen this long after it finishes drawing, then fades out —
 * marks do NOT accumulate, so the board never fills up with old boxes and only
 * the part being talked about is highlighted.
 *
 * This applies when a sentence highlights SEVERAL parts in turn and they have to
 * take turns. A mark that is the only one in its sentence instead stays lit for
 * the whole sentence and clears when the next section starts being spoken
 * (`WbAnnotation.holdUntilNext`).
 */
export const ANNOTATION_HOLD_SECONDS = 0.8;
export const ANNOTATION_HOLD_FRAMES = Math.round(ANNOTATION_HOLD_SECONDS * WB_FPS);
/** How long the fade-out itself takes, so the mark dissolves instead of blinking off. */
export const ANNOTATION_FADE_FRAMES = 6;

/**
 * Marker ink. ONE colour — an orange highlighter dot pointer draws every mark,
 * so the highlight layer reads as a single consistent pen rather than a set of
 * differently-coloured boxes. (Array kept so legacy configs still index it.)
 */
export const MARKER_COLORS = ["#F97316"] as const;
/** The pointer dot's colour (same ink as the strokes it lays down). */
export const MARKER_DOT_COLOR = "#F97316";

/**
 * A sentence owns a GROUP of crops (distilbook reveals 3-4 related images per
 * sentence), never a single lonely image — slicing merges batches until every
 * one holds at least this many components.
 */
export const MIN_COMPONENTS_PER_BATCH = 2;
/**
 * Target components per sentence, used to size the slice/brief so groups are rich.
 *
 * Boards are planned as PACKED news-style sections (see `buildBrief`), each a
 * little scene of many small labelled things rather than three big pictures — so
 * this is what a section is asked to hold, not a ceiling. The ceiling is
 * `WB_DETECT_MAX_PARTS_PER_GROUP`, and how many of them get MARKED is
 * `MAX_MARKS_PER_BATCH`.
 */
export const TARGET_COMPONENTS_PER_BATCH = 5;
/**
 * Upper bound on how many components of one batch get their own marker pass.
 * The script now gives every element its own fact-stating clause (see
 * `writeSectionNarration`), so each one has words of its own to be marked on —
 * this is the cap for a plan-sized cluster rather than a reason to skip parts.
 * The real limiter stays `capacity` in `buildBatchMarker`: how many strokes fit
 * in that sentence's actual audio without colliding.
 */
export const MAX_MARKS_PER_BATCH = 6;

// ─── Opus 5 segmentation ────────────────────────────────────────────────────
//
// The board is sliced by ONE Claude Opus 5 vision call (`detect-claude.ts`): it
// returns a tight bounding box for every distinct leaf part — every icon, every
// portrait, every arrow, every separate line of text — plus which CLUSTER each
// part belongs to. A cluster becomes one narration sentence; its parts pop onto
// the canvas one after another while that sentence is spoken.

/** Long edge (px) the board is downscaled to before it is sent to the model. */
export const WB_DETECT_MAX_SIDE = 2576;
/** Above this many bytes the board is re-encoded as JPEG to keep the request small. */
export const WB_DETECT_MAX_BYTES = 4.5 * 1024 * 1024;
/**
 * Grown around every returned box, as a fraction of the image's own dimensions.
 * Vision edges run a little tight; without this a crop can shave the last pixel
 * column off its own ink, which is very visible once it is scaled onto a 1280px
 * canvas. The UNPADDED box is kept as the marker target so the highlight still
 * hugs the ink rather than the padding.
 */
export const WB_DETECT_PAD_FRAC = 0.006;
/** Boxes smaller than this fraction of the image on either side are dropped. */
export const WB_DETECT_MIN_FRAC = 0.006;
/**
 * Hard ceiling on crops per board, so a dense poster can't balloon the render.
 * Set well above what a real board yields (a dense 16:9 poster slices to ~90):
 * a dropped crop is a hole in the finished board, so this is a runaway guard,
 * not a budget. The per-cluster cap below is the one that actually shapes a
 * sentence.
 */
export const WB_DETECT_MAX_PARTS = 96;
/**
 * Ceiling on parts in ONE cluster. Generous for the same reason as above: the
 * board is meant to end up COMPLETE, and a dropped crop is a hole in it (a
 * caption with no picture, an award row missing two of its trophies). Twenty
 * crops staggered across a five-second sentence still land a quarter-second
 * apart, which reads as a board filling in rather than a slideshow.
 */
export const WB_DETECT_MAX_PARTS_PER_GROUP = 20;

// ─── Crop isolation + VTracer ───────────────────────────────────────────────
//
// distilbook's crops are never plain rectangles (see `vectorize.ts`): line art
// ships as a transparent VTracer SVG, colour icons as a raster plus a traced
// outline. Ours are cut from vision boxes that deliberately run a few pixels
// wide of the ink, so without isolation a crop carries the edge of whatever sits
// next to it and stamps that fragment onto the canvas when it reveals.

/** Grown around the kept ink before it becomes the alpha channel (crop px). */
export const WB_ISOLATE_DILATE_PX = 3;
/** Blur radius on the alpha edge, so the cut-out doesn't read as a sticker. */
export const WB_ISOLATE_FEATHER_PX = 1;
/**
 * If keeping only the ink that touches the part's own tight box would throw away
 * more than this fraction of the crop's ink, the box is assumed to be off and
 * the crop is kept whole (background still stripped). A crop with a neighbour's
 * sliver in it is a far smaller defect than a crop with nothing in it.
 */
export const WB_ISOLATE_MIN_KEPT_FRAC = 0.35;

/** Crops are traced at this multiple of their pixel size (distilbook uses 4×). */
export const WB_TRACE_UPSCALE = 4;
/** …capped here, so a full-width banner can't become megabytes of path data. */
export const WB_TRACE_MAX_SIDE = 2400;
/** VTracer: discard traced patches smaller than this many pixels. */
export const WB_TRACE_FILTER_SPECKLE = 4;
/** VTracer spline fitting — the defaults visioncortex ships, which distilbook keeps. */
export const WB_TRACE_CORNER_THRESHOLD = 60;
export const WB_TRACE_LENGTH_THRESHOLD = 4;
export const WB_TRACE_SPLICE_THRESHOLD = 45;
export const WB_TRACE_PATH_PRECISION = 2;

/** The part types the model may return (distilbook's element vocabulary). */
export const WB_DETECT_KINDS = [
  "illustration",
  "icon",
  "photo",
  "chart",
  "arrow",
  "badge",
  "logo",
  "divider",
  "heading",
  "text",
  "caption",
  "label",
  "button",
  "other",
] as const;

export type WbDetectKind = (typeof WB_DETECT_KINDS)[number];

/** How a detected part is rendered: photos fade, flat colour wipes, ink draws. */
export function detectKindToVisualType(kind: WbDetectKind): VisualType {
  if (kind === "photo") return "photo";
  if (kind === "illustration" || kind === "icon" || kind === "chart" || kind === "badge" || kind === "logo" || kind === "button") {
    return "color_icon";
  }
  return "line_art"; // arrow, divider, heading, text, caption, label, other
}

/** …and which section slot it fills (`title` is reserved for the board's heading). */
export function detectKindToSectionKind(kind: WbDetectKind, isBoardTitle: boolean): SectionKind {
  if (isBoardTitle) return "title";
  if (kind === "photo") return "photo";
  if (kind === "chart") return "chart";
  if (kind === "illustration" || kind === "icon" || kind === "badge" || kind === "logo" || kind === "button") return "icon";
  return "point";
}

/**
 * Board FURNITURE — the parts that hold a layout together but say nothing.
 *
 * A tri-colour rule under the heading, the arrows between panels, a corner
 * flourish: these are drawn onto the canvas like everything else, but they are
 * not things a narrator has anything to say about. Handing them to the script as
 * material is how a video ends up narrating "below the green, orange and blue
 * bar…" — describing the furniture instead of reporting the story.
 */
const DECORATIVE_KINDS: ReadonlySet<string> = new Set(["divider", "arrow"]);

/**
 * Whether a part is something the narration should talk about and the marker
 * should land on. Furniture never is; a part with no printed words is only
 * narratable when it is a picture the sentence can be about.
 *
 * Note this governs the SCRIPT, not the render — every part still gets cropped
 * and revealed, because a board missing its arrows is a board with holes in it.
 */
export function isNarratablePart(kind: WbDetectKind | undefined, text?: string): boolean {
  if (kind && DECORATIVE_KINDS.has(kind)) return false;
  if (kind === "other" && !text?.trim()) return false;
  return true;
}

/** The reveal a visual type gets: ink is drawn, flat colour wipes, photos fade. */
export function revealStyleFor(visualType: VisualType): RevealStyle {
  if (visualType === "photo") return "fade";
  if (visualType === "color_icon") return "wipe";
  return "draw";
}

// ─── Grid layout ────────────────────────────────────────────────────────────
//
// Generated boards are drawn to a FIXED grid — one title band across the top,
// then `WB_GRID_COLS` × N panels below it — instead of a free composition that
// has to be found again afterwards with vision. The generator is told the grid,
// so cropping is pure arithmetic: no ink-islands, no bounding-box detection,
// nothing to mis-slice. Panel `i` is one crop, one sentence, one mark.

/**
 * The only layouts a generated board is allowed to use. Every one is a whole
 * rectangle — no ragged last row, so no panel is a different size from its
 * neighbours and no cell is left empty. The shape is picked from the requested
 * section budget (`gridShapeFor`), which is why 4/6/9 rather than any count.
 */
export const WB_GRID_SHAPES = [
  { panels: 4, cols: 2, rows: 2 },
  { panels: 6, cols: 3, rows: 2 },
  { panels: 9, cols: 3, rows: 3 },
] as const;

export type WbGridShape = (typeof WB_GRID_SHAPES)[number];

/** The allowed shape closest to `wanted` panels (ties round up — denser reads better). */
export function gridShapeFor(wanted: number): WbGridShape {
  let best: WbGridShape = WB_GRID_SHAPES[0];
  for (const s of WB_GRID_SHAPES) {
    if (Math.abs(s.panels - wanted) <= Math.abs(best.panels - wanted)) best = s;
  }
  return best;
}

/** Fraction of the board height taken by the title band above the panels. */
export const WB_GRID_TITLE_FRAC = 0.16;
/**
 * How far inside its cell each crop is taken, as a fraction of cell size. The
 * generator is asked to keep a clear gutter between panels; cropping just inside
 * the cell means a panel that drifts slightly still can't drag its neighbour's
 * ink into frame.
 */
export const WB_GRID_INSET_FRAC = 0.012;

/**
 * The crop rects for a grid board, in normalised (0..1) board coordinates and in
 * play order: index 0 is the title band, then the panels left-to-right,
 * top-to-bottom. Shared by the pipeline (to crop) and the brief (to describe the
 * layout to the image model), so the two cannot disagree.
 */
export function gridBoxes(shape: WbGridShape): Box[] {
  const { panels, cols, rows } = shape;
  const inset = WB_GRID_INSET_FRAC;
  const bodyY = WB_GRID_TITLE_FRAC;
  const cellW = 1 / cols;
  const cellH = (1 - bodyY) / rows;

  const boxes: Box[] = [
    // Title band: inset horizontally more than vertically — the title is one
    // centred line, and the extra margin keeps the panel row below it out.
    { x: 0.04, y: 0.01, w: 0.92, h: WB_GRID_TITLE_FRAC - 0.02 },
  ];
  for (let i = 0; i < panels; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    boxes.push({
      x: c * cellW + cellW * inset,
      y: bodyY + r * cellH + cellH * inset,
      w: cellW * (1 - 2 * inset),
      h: cellH * (1 - 2 * inset),
    });
  }
  return boxes;
}

/**
 * How far a mark stands off from the crop it belongs to — the SAME distance on
 * every side, so the mark reads as a frame around the element rather than
 * something drawn against it.
 *
 * Expressed in centimetres because that is how it is judged: watched at a normal
 * size, a 16:9 video fills roughly 19cm of screen height, so one centimetre is
 * about `WB_HEIGHT / 19` px — and defining it that way keeps the gap looking the
 * same whether the composition renders at 720p or 1440p.
 *
 * This is the knob to turn if marks sit too close to (or too far from) their
 * elements; everything downstream reads `MARKER_GAP_PX`.
 */
export const MARKER_GAP_CM = 1;
const SCREEN_HEIGHT_CM = 19;
export const MARKER_GAP_PX = Math.round((WB_HEIGHT / SCREEN_HEIGHT_CM) * MARKER_GAP_CM);
/**
 * …but never more than this share of the element's shorter side. A full
 * centimetre around a 20px icon is a box four times the size of the thing it is
 * marking, which reads as pointing at the whole neighbourhood; the proportional
 * cap keeps a small element's mark small and lets everything normally-sized have
 * the full centimetre.
 */
const MARKER_GAP_MAX_FRAC = 0.4;
/** …and never so tight that the mark sits on the ink. */
const MARKER_GAP_MIN_PX = 4;

/** The standoff to use for one element: a centimetre, bounded by its own size. */
export function markerGapFor(box: Box): number {
  const proportional = Math.round(Math.min(box.w, box.h) * MARKER_GAP_MAX_FRAC);
  return Math.max(MARKER_GAP_MIN_PX, Math.min(MARKER_GAP_PX, proportional));
}

// ─── Scene budget (mirrors lib/explainer-config.ts) ─────────────────────────

/** ~6 spoken sections (= 6 cropped images) per minute of finished video. */
export const SECTIONS_PER_MINUTE = 6;
const MIN_SECTIONS = 4;
const MAX_SECTIONS = 24;

/**
 * Upper bound on components for a USER-UPLOADED infographic. Uploads are sliced
 * exhaustively (every component explained step-by-step) rather than to a
 * duration budget, so they get a higher cap than generated infographics.
 */
export const MAX_UPLOAD_SECTIONS = 40;

export const WB_DURATIONS = [1, 2, 5] as const;
export type WbDuration = (typeof WB_DURATIONS)[number];

/** Number of sections/crops for a given duration (clamped to a sane range). */
export function sectionsForDuration(durationMinutes: number): number {
  return Math.max(MIN_SECTIONS, Math.min(MAX_SECTIONS, Math.round(durationMinutes * SECTIONS_PER_MINUTE)));
}

// ─── Shared playback types (the tutor_config contract) ──────────────────────

export type SectionKind = "title" | "point" | "chart" | "icon" | "photo";
export type RevealStyle = "draw" | "wipe" | "fade";
/**
 * How a section is rendered/revealed (distilbook's `visual_type`):
 *  - line_art: dark text/arrows/diagrams → vector-traced and stroke-drawn like a pen
 *  - color_icon: flat colourful icons/charts/flags → raster crop, wipe reveal
 *  - photo: realistic photos/portraits → raster crop, fade reveal
 */
export type VisualType = "line_art" | "color_icon" | "photo";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The infographic cropped to its content, plus where it sits on the canvas. */
export interface WbBoard {
  url: string;
  rect: Box;
}


export interface WbSection {
  id: number;
  kind: SectionKind;
  label: string;
  /** Cropped section image (its own file in R2), masked to its own ink. */
  imageUrl: string;
  /**
   * VTracer outline of this crop — transparent `#000000` paths, no background
   * (see `vectorize.ts`). Line art is RENDERED from this instead of the raster,
   * which is what makes an overlapping crop physically unable to occlude its
   * neighbour. Absent when tracing was skipped or produced nothing.
   */
  svgUrl?: string;
  /**
   * True when `imageUrl` carries a real alpha channel (its page background and
   * any neighbouring sliver already removed). Configs generated before crop
   * isolation existed do not, and are still composited with `multiply` so their
   * opaque white rectangles keep behaving as they always did.
   */
  isolated?: boolean;
  /** Source crop rect in the ORIGINAL infographic's pixel space. */
  box: Box;
  /** Placement on the video canvas (editor-editable). */
  placement: Box;
  /**
   * Precise canvas-space box of the ONE element the marker underlines / circles
   * (Gemini 2.5 bounding box — the heading line for text, the figure for a visual).
   * Falls back to `placement` when marker-target detection is unavailable.
   */
  markerBox?: Box;
  /** Verbatim text read from the marked element (Gemini) — grounds narration + word-sync. */
  markerText?: string;
  /**
   * The planned KEYWORD this crop stands for ("global minimum", "f(x,y)") — the
   * phrase printed on the board here AND spoken verbatim in this section's
   * sentence. It is the sync key: the marker lands on this crop at the frame the
   * narrator says these words. Set when the board came from a planned brief.
   */
  keyword?: string;
  revealStyle: RevealStyle;
  /**
   * Reveal batch index (Inkplainer's `animOrder` / distilbook's sentence-batch):
   * every section sharing an `order` is revealed together under ONE narration
   * sentence, and batches play in sequence. Undefined ⇒ its own batch.
   */
  order?: number;
  /** distilbook-style render type; drives underline vs circle when marking. */
  visualType?: VisualType;
  /** The raw part type detection returned — see `isNarratablePart`. */
  detectKind?: WbDetectKind;
  startFrame: number;
  endFrame: number;
  /** Seconds into the audio the reveal starts (distilbook's `startTime`). */
  startTime?: number;
  /** True when the reveal was word/segment-synced (vs interpolated fallback). */
  matched?: boolean;
  triggerSentence: string;
}

/**
 * A part of the infographic found by detection, before it has been cropped.
 *
 * Lives here (not in `generate.ts`) so the detectors can produce it without
 * importing the pipeline — `detect-claude.ts` and `generate.ts` both depend on
 * this file and never on each other.
 */
export interface DetectedSection {
  kind: SectionKind;
  label: string;
  /** Normalised box (0..1) in the infographic — robust to the image's real size. */
  boxNorm: Box;
  /** distilbook render type; line_art gets vector stroke-draw, the rest stay raster. */
  visualType?: VisualType;
  /** The raw part type detection returned — see `isNarratablePart`. */
  detectKind?: WbDetectKind;
  /** Reveal batch (Inkplainer animOrder). Components sharing it explain together. */
  order?: number;
  /**
   * Precise normalised box (0..1) of the single element the marker should target,
   * tighter than the whole section region (which carries a little padding so the
   * crop can't clip its own ink). Optional — absent sections fall back to their
   * full box when marking.
   */
  markerBoxNorm?: Box;
  /** Verbatim text read out of the region — grounds narration + word-sync. */
  markerText?: string;
  /** The keyword this region stands for (see `WbSection.keyword`). */
  keyword?: string;
}

/** A point on an annotation's pen path; `t` is 0→1 progress along the stroke. */
export interface WbCursorPathPoint {
  x: number;
  y: number;
  t: number;
}

export interface WbAnnotation {
  id: number;
  /**
   * underline: line under a text element; circle: ring around a roundish icon;
   * square: rect outline around a photo/chart (distilbook's `gesture` rect);
   * marking: short side-tick beside an element too small to underline or box.
   */
  type: "underline" | "circle" | "square" | "marking";
  /**
   * underline/marking: {from,to}; circle: {cx,cy,radius};
   * square: {path: [{x,y} × 5, closed]} — all in canvas space.
   */
  geometry: Record<string, number | { x: number; y: number } | Array<{ x: number; y: number }>>;
  color: string;
  startFrame: number;
  endFrame: number;
  sectionId: number;
  /**
   * Stay lit until the NEXT mark starts, instead of fading `ANNOTATION_HOLD_FRAMES`
   * after the stroke finishes. Set when this mark is the only one in its sentence:
   * the highlight then covers the whole time that section is being talked about
   * and moves on exactly when the narrator does.
   */
  holdUntilNext?: boolean;
  /** Pen path along the stroke (distilbook's per-tag `cursorPath`). */
  cursorPath?: WbCursorPathPoint[];
}

export interface WbCursorWaypoint {
  frame: number;
  x: number;
  y: number;
  state: "traveling" | "drawing";
  sectionId?: number;
}

export interface WbTutorConfig {
  metadata: {
    width: number;
    height: number;
    fps: number;
    totalFrames: number;
    totalDuration: number;
    bgColor: string;
    aspectRatio: string;
    /** LEGACY (whole-board draw model): frame the initial board sketch ends. */
    drawEndFrame?: number;
  };
  audio: { url: string };
  infographic: { url: string; width: number; height: number };
  /** LEGACY (whole-board draw model): the board image + its canvas rect. */
  board?: WbBoard;
  sections: WbSection[];
  annotations: WbAnnotation[];
  cursor: { waypoints: WbCursorWaypoint[] };
}

// ─── Render/export job (pure, shared by every export entry point) ───────────

/** The Remotion composition id a whiteboard explainer renders with. */
export const WB_COMPOSITION_ID = "whiteboard-explainer";

export interface WbRenderJob {
  compositionId: string;
  inputProps: Record<string, unknown>;
  width: number;
  height: number;
  durationInFrames: number;
}

/**
 * Turn a saved project record into the EXACT render job the editor's preview is
 * playing — or null when it isn't a whiteboard explainer.
 *
 * The export must be frame-for-frame what the user sees: the crops at their
 * (possibly repositioned) placements, the marks hugging them, the pointer path,
 * the reveal timings. All of that lives in the `whiteboardConfig` manifest — the
 * editor bakes any drag-repositioning straight into it — so exporting is just
 * "render THIS manifest with the whiteboard composition", never the generic
 * clip-list composition (which would produce a completely different video).
 *
 * Shared by the Inngest export worker and the Share/quick-render route so the
 * two can never drift apart.
 */
export function whiteboardRenderJob(videoData: Record<string, unknown>): WbRenderJob | null {
  const cfg = videoData.whiteboardConfig as WbTutorConfig | null | undefined;
  const template = String(videoData.template ?? videoData.themeId ?? videoData.theme ?? "");
  if (!cfg?.metadata || !Array.isArray(cfg.sections)) {
    // A whiteboard project without its manifest can't be rendered faithfully;
    // say so rather than silently exporting the wrong composition.
    if (template === WB_COMPOSITION_ID) {
      throw new Error("Whiteboard explainer export is missing its whiteboardConfig manifest");
    }
    return null;
  }
  const m = cfg.metadata;
  return {
    compositionId: WB_COMPOSITION_ID,
    inputProps: {
      whiteboardConfig: cfg,
      // Placements are already baked into `cfg.sections` by the editor; passing
      // the overrides too would double-apply them.
      sectionPlacements: null,
      voiceoverVolume: (videoData.voiceoverVolume as number) ?? 1,
      musicUrl: (videoData.musicUrl as string) || null,
      musicVolume: (videoData.musicVolume as number) ?? 0.12,
      showWatermark: videoData.showWatermark ?? true,
    },
    width: m.width || WB_WIDTH,
    height: m.height || WB_HEIGHT,
    durationInFrames: Math.max(m.fps || WB_FPS, m.totalFrames || 0),
  };
}

// ─── Mark geometry (pure, shared by pipeline + editor + composition) ────────
//
// These are dependency-free on purpose: the server pipeline (generate.ts) uses
// them to build the initial marks, and the browser editor re-derives a mark with
// the SAME rules when the user drags its crop, so mark and image never drift.

/** The shape-and-path part of an annotation (everything but colour/timing). */
export type WbMark = Pick<WbAnnotation, "type" | "geometry" | "cursorPath">;

const clampX = (x: number) => Math.max(1, Math.min(WB_WIDTH - 1, x));
const clampY = (y: number) => Math.max(1, Math.min(WB_HEIGHT - 1, y));

/** Wide-and-short text blocks (w ≥ ratio·h) read as a line → underline them. */
const MARK_TEXT_ASPECT = 2.5;

/**
 * ~13-point clockwise-from-top pen path around a circle.
 *
 * Nothing produces circles any more (see `annotationMarkFor`), but configs
 * generated before that change still contain them and still have to play.
 */
function circleCursorPath(cx: number, cy: number, radius: number): WbCursorPathPoint[] {
  const N = 12;
  const pts: WbCursorPathPoint[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = -Math.PI / 2 + t * 2 * Math.PI; // top → clockwise
    pts.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a), t });
  }
  return pts;
}

/** Pen path along a polyline, `t` proportional to distance travelled. */
function polylineCursorPath(points: Array<{ x: number; y: number }>): WbCursorPathPoint[] {
  const legs = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  const total = Math.max(1, legs.reduce((a, l) => a + l, 0));
  let acc = 0;
  return points.map((p, i) => {
    if (i > 0) acc += legs[i - 1];
    return { x: p.x, y: p.y, t: acc / total };
  });
}

/**
 * The mark for a section: exactly TWO shapes, both squared to the element and
 * both standing `markerGapFor` (a centimetre, bounded by the element's own size)
 * clear of it.
 *
 *   a line of text  → an underline that runs the element's full width, one gap
 *                     below its baseline
 *   anything else   → a bounding box, one gap outside on all four sides
 *
 * There used to be a circle for roundish icons and a short vertical tick beside
 * anything small. Both marked from the SIDE of an element rather than around it,
 * which reads as the pen pointing somewhere near the thing instead of at it —
 * and a tick is ambiguous about which of two adjacent crops it belongs to. The
 * types stay in `WbAnnotation` and still render, because configs made before
 * this change contain them.
 *
 * `box` overrides the target box (defaults to the precise `markerBox`, falling
 * back to the whole crop `placement`).
 */
export function annotationMarkFor(section: WbSection, box?: Box): WbMark {
  const b = box ?? section.markerBox ?? section.placement;
  const gap = markerGapFor(b);
  const isText =
    section.visualType === "line_art" || section.kind === "title" || section.kind === "point";

  // A line of text → underline it, one gap below, spanning its whole width.
  if (isText && b.w >= MARK_TEXT_ASPECT * b.h) {
    const y = clampY(b.y + b.h + gap);
    const from = { x: clampX(b.x), y };
    const to = { x: clampX(b.x + b.w), y };
    return { type: "underline", geometry: { from, to }, cursorPath: polylineCursorPath([from, to]) };
  }

  // Everything else → a bounding box one gap outside the element, drawn
  // clockwise from the top-left like distilbook's gesture rects.
  const x0 = clampX(b.x - gap);
  const y0 = clampY(b.y - gap);
  const x1 = clampX(b.x + b.w + gap);
  const y1 = clampY(b.y + b.h + gap);
  const path = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
    { x: x0, y: y0 },
  ];
  return { type: "square", geometry: { path }, cursorPath: polylineCursorPath(path) };
}

/** An annotation's pen path, deriving one from geometry for legacy configs. */
export function annotationCursorPath(ann: WbAnnotation): WbCursorPathPoint[] {
  if (ann.cursorPath?.length) return ann.cursorPath;
  if (ann.type === "circle") {
    return circleCursorPath(ann.geometry.cx as number, ann.geometry.cy as number, ann.geometry.radius as number);
  }
  if (ann.type === "square") {
    return polylineCursorPath((ann.geometry.path as Array<{ x: number; y: number }>) ?? []);
  }
  const from = ann.geometry.from as { x: number; y: number };
  const to = ann.geometry.to as { x: number; y: number };
  return polylineCursorPath([from, to]);
}

/** Frames the pen glides toward a mark before drawing it. */
const MARK_TRAVEL_LEAD_FRAMES = 8;

/**
 * The full traveling/drawing waypoint stream from the annotation list — the
 * distilbook `cursor.waypoints` contract: rest at the previous mark's end, glide
 * to the next mark's start, then ride its cursorPath while it draws.
 */
export function cursorWaypointsFor(annotations: WbAnnotation[]): WbCursorWaypoint[] {
  const waypoints: WbCursorWaypoint[] = [];
  const sorted = [...annotations].sort((a, b) => a.startFrame - b.startFrame);
  for (const ann of sorted) {
    const path = annotationCursorPath(ann);
    if (!path.length) continue;
    const first = path[0];
    const prev = waypoints[waypoints.length - 1];
    if (prev) {
      waypoints.push({ frame: prev.frame, x: prev.x, y: prev.y, state: "traveling" });
      waypoints.push({
        frame: Math.max(prev.frame, ann.startFrame),
        x: first.x,
        y: first.y,
        state: "traveling",
      });
    } else {
      waypoints.push({
        frame: Math.max(0, ann.startFrame - MARK_TRAVEL_LEAD_FRAMES),
        x: first.x,
        y: first.y,
        state: "traveling",
        sectionId: ann.sectionId,
      });
    }
    const span = Math.max(1, ann.endFrame - ann.startFrame);
    for (const p of path) {
      waypoints.push({
        frame: Math.round(ann.startFrame + span * p.t),
        x: p.x,
        y: p.y,
        state: "drawing",
        sectionId: ann.sectionId,
      });
    }
  }
  return waypoints;
}
