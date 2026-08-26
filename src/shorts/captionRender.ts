/**
 * Per-word caption styling, shared by every renderer so the browser preview and
 * the exported MP4 cannot drift.
 *
 * VERBATIM COPY at render/src/captionRender.ts. The render server is a separate
 * package and cannot import across that boundary (same arrangement as
 * lib/splitLayout.ts), but the two must agree exactly: this file decides what
 * the user sees, that one decides what they download.
 *
 * ── What changed here versus the inline styling this replaces ────────────────
 *
 * 1. STROKE IS APPLIED. `outlineColor`/`outlineWidth` were declared in both
 *    compositions' CaptionStyle and read by neither, so captions had only a drop
 *    shadow to separate them from the footage. `paintOrder: "stroke fill"` draws
 *    the stroke first and the glyph over it, so the outline sits OUTSIDE the
 *    letterform; without it -webkit-text-stroke centres the stroke and eats into
 *    thin strokes at the widths a 1080×1920 caption needs.
 *
 * 2. THE LINE NO LONGER JUMPS. The old code grew the active word with BOTH
 *    `fontSize * 1.2` and `transform: scale(1.1)`. font-size participates in
 *    layout, so every word becoming active re-flowed the whole line and shifted
 *    its neighbours sideways — visible as a twitch on every single word. Scale is
 *    a transform only, so the pop happens without touching layout.
 *
 * 3. HIGHLIGHT IS ITS OWN AXIS. Previously any style with a background painted it
 *    behind every word, so "background on / off" was the only structural choice.
 *    See CaptionHighlight.
 *
 * 4. THE POP RESERVES ITS OWN ROOM. `transform: scale()` does not participate in
 *    layout, so a word scaled to 1.14 grew 7% of its own width past each edge of
 *    the box the flex gap was measured against — and a word's width is a multiple
 *    of the gap, so a long word simply ran over its neighbour. Fixed by inverting
 *    which state is the layout size: every word is laid out at the POPPED size and
 *    the inactive ones are scaled BACK DOWN by 1/pop. Nothing ever exceeds its own
 *    box, so the gap is honoured whatever the word length, and because the layout
 *    is identical for active and inactive the line still never reflows (note 2).
 *    The px-valued decorations are multiplied by pop for the same reason, which
 *    leaves what you actually see unchanged: an inactive word still renders at
 *    exactly `fontSize` with an `outlineWidth` stroke, an active one at
 *    `fontSize * activeScale`. Only the spacing between them changes.
 */

import type { CSSProperties } from "react";

/** The subset of a caption style this module reads. All fields optional: styles stored before these existed still render. */
export interface CaptionRenderStyle {
  fontSize?: number;
  color?: string;
  backgroundColor?: string;
  bgOpacity?: number;
  inactiveColor?: string;
  inactiveBackgroundColor?: string;
  fontFamily?: string;
  fontWeight?: string | number;
  textTransform?: "uppercase" | "lowercase" | "capitalize" | "none";
  borderRadius?: number;
  padding?: string;
  textShadow?: string;
  outlineColor?: string;
  outlineWidth?: number;
  highlight?: "color" | "pill" | "box" | "underline";
  activeScale?: number;
  letterSpacing?: number;
}

export function hexToRgba(hex: string, opacity: number): string {
  const clean = hex.replace("#", "");
  if (clean.length < 6) return hex;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * The accent fill, honouring bgOpacity, or "transparent" when there is none.
 * `bgOpacity: 0` means "no background" and wins over any backgroundColor —
 * every preset stores a backgroundColor whether it paints one or not.
 */
export function captionAccent(style: CaptionRenderStyle): string {
  const opacity = style.bgOpacity;
  if (opacity === 0) return "transparent";
  const bg = style.backgroundColor;
  if (!bg || bg === "transparent") return "transparent";
  if (opacity !== undefined && opacity < 1 && bg.startsWith("#")) return hexToRgba(bg, opacity);
  return bg;
}

/**
 * Which highlight treatment to use.
 *
 * Styles saved before `highlight` existed get the behaviour they had: a
 * background meant a block behind every word, no background meant a colour swap.
 */
export function captionHighlight(style: CaptionRenderStyle): "color" | "pill" | "box" | "underline" {
  if (style.highlight) return style.highlight;
  return captionAccent(style) === "transparent" ? "color" : "box";
}

/**
 * Map a legacy OS font name onto the nearest loaded family.
 *
 * Every short generated before webfonts existed has an OS family stored on it —
 * "Impact", "Palatino", "Marker Felt", "Segoe UI". None of those are in the
 * render container, so re-rendering such a short still produced a fallback face
 * even after the fonts were added, and the fix would only ever have reached newly
 * generated clips. Substituting here means an old short picks up a real typeface
 * on its next render, without a data migration.
 *
 * Matched on the FIRST family in the stack: anything already naming a loaded
 * family (every current preset) falls straight through untouched.
 */
const LEGACY_FONTS: Record<string, string> = {
  // Condensed display -> Anton
  "impact": `"Anton", Impact, "Arial Narrow", sans-serif`,
  // Heavy block -> Archivo Black
  "arial black": `"Archivo Black", "Arial Black", sans-serif`,
  // Serifs -> Playfair Display
  "georgia": `"Playfair Display", Georgia, serif`,
  "palatino": `"Playfair Display", Georgia, serif`,
  "times new roman": `"Playfair Display", Georgia, serif`,
  // Comic / handwritten -> Luckiest Guy, Permanent Marker
  "comic sans ms": `"Luckiest Guy", "Comic Sans MS", cursive`,
  "marker felt": `"Permanent Marker", "Marker Felt", cursive`,
  // Monospace -> Space Mono
  "courier new": `"Space Mono", "Courier New", monospace`,
  // Everything else was a neutral grotesque -> Inter
  "system-ui": `"Inter", system-ui, -apple-system, sans-serif`,
  "arial": `"Inter", system-ui, -apple-system, sans-serif`,
  "helvetica": `"Inter", system-ui, -apple-system, sans-serif`,
  "helvetica neue": `"Inter", system-ui, -apple-system, sans-serif`,
  "verdana": `"Inter", system-ui, -apple-system, sans-serif`,
  "trebuchet ms": `"Inter", system-ui, -apple-system, sans-serif`,
  "segoe ui": `"Inter", system-ui, -apple-system, sans-serif`,
};

export function resolveCaptionFont(fontFamily: string | undefined): string {
  if (!fontFamily) return `"Inter", system-ui, -apple-system, sans-serif`;
  const first = fontFamily.split(",")[0].trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  return LEGACY_FONTS[first] ?? fontFamily;
}

/**
 * Multiply every px length in a shorthand value ("10px 22px") by `factor`, so a
 * padding written against the base font size survives being laid out against the
 * popped one. Non-px units and keywords pass through untouched.
 */
function scalePxLengths(value: string, factor: number): string {
  if (factor === 1) return value;
  return value.replace(/(-?[\d.]+)px/g, (_m, n: string) => `${(parseFloat(n) * factor).toFixed(2)}px`);
}

/** The style for one word of the active caption group. */
export function captionWordStyle(style: CaptionRenderStyle, isActive: boolean): CSSProperties {
  const highlight = captionHighlight(style);
  const accent = captionAccent(style);
  // See note 4 in the file header: the layout size is the POPPED size, and every
  // px-valued decoration is scaled with it so the rendered result is unchanged.
  const pop = Math.max(1, style.activeScale ?? 1.12);
  const fontSize = (style.fontSize ?? 84) * pop;
  const outlineWidth = (style.outlineWidth ?? 0) * pop;

  // `pill` fills the active word alone; `box` fills the whole group so the line
  // reads as one bar. The other two paint nothing.
  const background =
    highlight === "pill" ? (isActive ? accent : "transparent")
    : highlight === "box" ? (isActive
        ? accent
        : (style.inactiveBackgroundColor && style.inactiveBackgroundColor !== "transparent"
            ? style.inactiveBackgroundColor
            : accent))
    : "transparent";
  const hasBackground = background !== "transparent";

  // Underline scales with the type so it stays proportional at any fontSize.
  //
  // The rule colour comes from `backgroundColor` directly, NOT from `accent`:
  // `accent` is gated on bgOpacity, which an underline preset leaves at 0 because
  // it paints no fill — so reading it here always fell through to the text colour
  // and the preset's chosen rule colour was silently ignored.
  const rule = style.backgroundColor && style.backgroundColor !== "transparent"
    ? style.backgroundColor
    : (style.color ?? "#FFFFFF");
  const underline = highlight === "underline" && isActive
    ? `${Math.max(4, Math.round(fontSize * 0.09))}px solid ${rule}`
    : undefined;

  return {
    display: "inline-block",
    // Identical for active and inactive — the pop is transform-only, so the line
    // never reflows (notes 2 and 4).
    fontSize: `${fontSize}px`,
    lineHeight: 1.05,
    // Legacy OS family names are swapped for the nearest loaded face — see
    // resolveCaptionFont. A stack already naming a loaded family passes through.
    fontFamily: resolveCaptionFont(style.fontFamily),
    fontWeight: style.fontWeight,
    textTransform: style.textTransform,
    letterSpacing: style.letterSpacing ? `${style.letterSpacing * pop}px` : undefined,
    color: isActive ? style.color : style.inactiveColor,

    backgroundColor: hasBackground ? background : undefined,
    padding: hasBackground ? scalePxLengths(style.padding ?? "10px 22px", pop) : undefined,
    borderRadius: hasBackground ? `${(style.borderRadius ?? 16) * pop}px` : undefined,
    borderBottom: underline,
    // Keeps the row from shifting when only the active word gains a rule.
    paddingBottom: highlight === "underline" ? Math.round(fontSize * 0.12) : undefined,

    WebkitTextStroke: outlineWidth > 0 ? `${outlineWidth}px ${style.outlineColor ?? "#000000"}` : undefined,
    // Stroke behind the fill, so the outline grows outward instead of thinning
    // the glyph. Without this a 10px stroke swallows the letter.
    paintOrder: outlineWidth > 0 ? "stroke fill" : undefined,

    // A shadow under a filled pill just muddies its edge.
    textShadow: hasBackground ? undefined : (style.textShadow || undefined),
    boxShadow: hasBackground && isActive ? "0 6px 20px rgba(0,0,0,0.35)" : undefined,

    // Active is the layout size; inactive shrinks back inside its own box.
    transform: isActive ? "scale(1)" : `scale(${(1 / pop).toFixed(4)})`,
    transformOrigin: "center center",
    zIndex: isActive ? 10 : 1,
  };
}

/**
 * The container for the active caption group.
 *
 * `atSplitSeam` moves the captions to the middle of the frame for the frames a
 * B-roll cutaway is on screen.
 *
 * A cutaway is a 50/50 top-bottom split (see splitLayout.ts), so the normal
 * `positionBottom` of 18% lands the captions in the lower-middle of whichever
 * half is at the bottom — usually squarely over the stock footage, hiding the
 * thing the cutaway was added to show. Centred on the seam the block straddles
 * the boundary instead: it reads as the divider between the two shots, covers
 * the least of either, and the captions do not jump when the cutaway ends,
 * because the seam is where the eye already is.
 *
 * Centring is done with `top: 50%` + `translateY(-50%)` rather than a percentage
 * `bottom`, so the block's own height is what gets centred — a one-line and a
 * two-line group both sit balanced across the seam instead of the two-line one
 * hanging below it.
 */
export function captionGroupStyle(
  style: CaptionRenderStyle & { positionBottom?: number; layout?: "inline" | "stacked" },
  atSplitSeam = false
): CSSProperties {
  const layout = style.layout ?? "inline";
  const stacked = layout === "stacked";
  return {
    position: "absolute",
    ...(atSplitSeam
      ? { top: "50%", transform: "translateY(-50%)" }
      : { bottom: `${style.positionBottom ?? 18}%` }),
    left: 72,
    right: 72,
    display: "flex",
    flexWrap: stacked ? "nowrap" : "wrap",
    flexDirection: stacked ? "column" : "row",
    justifyContent: "center",
    alignItems: "center",
    // Wide enough that adjacent strokes don't collide at the heaviest presets.
    gap: stacked ? 14 : 22,
  };
}
