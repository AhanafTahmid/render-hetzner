/**
 * Per-word caption styling, shared by every surface that draws a caption, so the
 * browser preview and the exported MP4 cannot drift.
 *
 * VERBATIM COPY of vidgpt/lib/captionRender.ts. The render server is a separate
 * repo and cannot import across that boundary (same arrangement as
 * buildTimeline.ts), but the two must agree exactly: that file decides what the
 * user sees in the editor, this one decides what they download.
 *
 * Callers: app/dashboard/_components/{RemotionVideo,BlogTemplatePlayer}.tsx and
 * their render-server counterparts, plus the editor's Captions panel for chips.
 *
 * ── What this adds over the inline styling it replaces ───────────────────────
 *
 * 1. STROKE. There was none — captions had a drop shadow and nothing else to
 *    separate them from the footage. A stroke is what keeps text readable over
 *    moving video, and it is the control OpusClip puts front and centre next to
 *    font/size/colour/case. `paintOrder: "stroke fill"` draws the stroke first
 *    and the glyph over it, so the outline sits OUTSIDE the letterform; without
 *    it `-webkit-text-stroke` centres the stroke and eats into the glyph at the
 *    widths a full-frame caption needs.
 *
 * 2. THE LINE NO LONGER JUMPS OR COLLIDES. The old code grew the spoken word
 *    with `font-size: calc(Npx * 1.06)`. font-size participates in layout, so
 *    every word becoming active re-flowed the line and shifted its neighbours
 *    sideways — a twitch on every word. A `transform` does not reflow, but it
 *    also does not reserve space, so a scaled word simply overlaps its
 *    neighbour: the overflow is a percentage of the WORD'S width, which is a
 *    large multiple of any fixed gap.
 *
 *    Fixed by inverting which state is the layout size: every word is laid out
 *    at the POPPED size and the inactive ones are scaled BACK DOWN by 1/pop.
 *    Nothing ever exceeds its own box, so word spacing survives any word length,
 *    and because active and inactive share one layout the line never reflows.
 *    The px-valued decorations are multiplied by pop for the same reason, which
 *    leaves what you see unchanged: an inactive word still renders at exactly
 *    `fontSize`, an active one at `fontSize * activeScale`.
 *
 * 3. HIGHLIGHT IS ITS OWN AXIS. Previously the only structural choice was the
 *    group background swatch, painted behind the whole line. See CaptionHighlight
 *    in captionPresets.ts. The group swatch is untouched and still the user's.
 *
 * ── Nothing here changes an existing video ───────────────────────────────────
 * Every new field is optional, and each default is the value the old inline code
 * used: no stroke, `color` highlight, `activeScale` 1.06, and the same two-tier
 * drop shadow. A caption style saved before any of this existed renders exactly
 * as it did, on the same fonts, at the same size.
 */

import type { CSSProperties } from "react";

/** The pop the inline code applied via font-size. Kept as the default so styles saved before `activeScale` existed are unchanged. */
export const LEGACY_ACTIVE_SCALE = 1.06;

/** The shadow the inline code applied when the group had no background. */
const LEGACY_SHADOW_ACTIVE = "2px 2px 8px rgba(0,0,0,0.9), 0 0 20px rgba(0,0,0,0.5)";
const LEGACY_SHADOW_INACTIVE = "1px 1px 4px rgba(0,0,0,0.7)";

/** The subset of a caption style this module reads. All fields optional: styles stored before these existed still render. */
export interface CaptionRenderStyle {
  fontSize?: number;
  fontWeight?: number | string;
  fontFamily?: string;
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  activeColor?: string;
  inactiveColor?: string;
  letterSpacing?: number;
  /** How the spoken word is marked out. Defaults to a colour swap. */
  highlight?: "color" | "pill" | "box" | "underline";
  /** Pill/box fill, or the underline rule colour. Separate from the group background swatch. */
  highlightColor?: string;
  outlineColor?: string;
  /** Stroke as a fraction of the rendered font size — survives a size change. Wins over outlineWidth. */
  outlineRatio?: number;
  /** Stroke in px, for a style that pins one. */
  outlineWidth?: number;
  textShadow?: string;
  /** How much the spoken word grows. */
  activeScale?: number;
  borderRadius?: number;
  padding?: string;
}

/**
 * Map a legacy OS font name onto the nearest bundled family.
 *
 * Every video made before this existed stores an OS family — "Impact",
 * "Palatino", "Marker Felt", "Segoe UI". None of those are in the render
 * container (Dockerfile installs Chromium libraries and no fonts), so those
 * videos have always exported in a fallback face while the macOS preview showed
 * the real one. Substituting here means an old video picks up a real typeface on
 * its next render AND that its preview finally matches its export, without a
 * data migration.
 *
 * Matched on the FIRST family in the stack, so anything already naming a bundled
 * family — every current preset, and the Patrick Hand comic stack — falls
 * straight through untouched.
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

/**
 * Script coverage for caption text outside Latin.
 *
 * CSS resolves fonts PER CHARACTER: for each glyph the browser walks the stack
 * and takes the first family that has it. Appending script faces therefore needs
 * no language detection, and it is the right mechanism rather than merely the
 * cheap one — "आपका mindset बदलो" is one line with two scripts in it, and
 * Hinglish/Banglish podcasts are full of them. Choosing one font per video would
 * render the English half in a Devanagari face, or the Devanagari half in tofu.
 *
 * The tail matches the CHARACTER of the stack it is appended to, so a Comic
 * caption stays comic in Hindi instead of dropping to a neutral sans: the Baloo
 * 2 superfamily is one rounded, comic-adjacent face per Indic script plus
 * Arabic, with Itim for Thai, Gaegu for Korean and Zen Maru Gothic for Japanese.
 * Chinese, Hebrew and Sinhala have no comic face on Google Fonts and fall
 * through to the Noto net — legible, just not playful.
 *
 * Where the families come from: Noto via the fonts-noto-* apt packages in the
 * Dockerfile, Baloo/Itim/Gaegu/Zen Maru Gothic bundled in captionFonts.ts.
 * Mirror of lib/captionPresets.ts in the app — if the two lists drift, the
 * preview stops predicting the export.
 */
// One definition, shared with the shorts path. This block used to be a
// hand-copied duplicate of it; the shorts copy fell behind and Bengali/Hindi/
// Arabic captions exported as tofu boxes, so the duplicate is gone.
import { withScriptFallbacks, type FontCharacter } from "./shorts/scriptFallbacks";

/**
 * Read off the leading family, because a stored style carries only the stack.
 * This is what keeps an already-generated Luckiest Guy short landing on comic
 * script faces on its next render, rather than a neutral sans.
 */
const FONT_CHARACTER_BY_FAMILY: Record<string, FontCharacter> = {
  "luckiest guy": "comic",
  "permanent marker": "comic",
  "comic sans ms": "comic",
  "marker felt": "comic",
  "anton": "display",
  "bebas neue": "display",
  "archivo black": "display",
  "arial black": "display",
  "impact": "display",
  "playfair display": "serif",
  "georgia": "serif",
  "space mono": "mono",
  "courier new": "mono",
};

export function resolveCaptionFont(fontFamily: string | undefined): string {
  if (!fontFamily) return withScriptFallbacks(`"Luckiest Guy", "Comic Sans MS", cursive`, "comic");
  const first = fontFamily.split(",")[0].trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  const character = FONT_CHARACTER_BY_FAMILY[first] ?? "sans";
  return withScriptFallbacks(LEGACY_FONTS[first] ?? fontFamily, character);
}

/** Which highlight treatment to use. Styles saved before `highlight` existed get the colour swap they had. */
export function captionHighlight(style: CaptionRenderStyle): "color" | "pill" | "box" | "underline" {
  return style.highlight ?? "color";
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

/**
 * The style for one word of the active caption group.
 *
 * @param groupHasBackground whether the caller is painting the group background
 *   swatch behind the whole line. Only used to drop the drop-shadow, which just
 *   muddies text sitting on a solid panel — exactly what the inline code did.
 */
export function captionWordStyle(
  style: CaptionRenderStyle,
  isActive: boolean,
  groupHasBackground = false
): CSSProperties {
  const highlight = captionHighlight(style);

  // See note 2: the layout size is the POPPED size, and every px-valued
  // decoration scales with it so the rendered result is unchanged.
  const pop = Math.max(1, style.activeScale ?? LEGACY_ACTIVE_SCALE);
  const baseSize = style.fontSize ?? 72;
  const fontSize = baseSize * pop;

  const outlineWidth =
    style.outlineRatio !== undefined
      ? fontSize * style.outlineRatio
      : (style.outlineWidth ?? 0) * pop;

  // `pill` fills the active word alone; `box` fills every word so the line reads
  // as one bar. `color` and `underline` paint nothing behind the text.
  const fill = style.highlightColor;
  const background =
    fill && highlight === "pill" ? (isActive ? fill : "transparent")
    : fill && highlight === "box" ? fill
    : "transparent";
  const hasBackground = background !== "transparent";

  // The rule scales with the type so it stays proportional at any size.
  const rule = style.highlightColor ?? style.activeColor ?? "#FFFFFF";
  const underline = highlight === "underline" && isActive
    ? `${Math.max(4, Math.round(fontSize * 0.09))}px solid ${rule}`
    : undefined;

  const shadow =
    hasBackground || groupHasBackground
      ? undefined
      : style.textShadow !== undefined
        ? (style.textShadow === "none" ? undefined : style.textShadow)
        : (isActive ? LEGACY_SHADOW_ACTIVE : LEGACY_SHADOW_INACTIVE);

  return {
    display: "inline-block",
    // Identical for active and inactive — the pop is transform-only, so the line
    // never reflows (note 2).
    fontSize: `${fontSize}px`,
    // No line-height here on purpose: the caption container sets its own
    // (1.2 inline, 1.4 stacked) and a per-word value would override it.
    // Legacy OS family names are swapped for the nearest bundled face — see
    // resolveCaptionFont. A stack already naming a bundled family passes through.
    fontFamily: resolveCaptionFont(style.fontFamily),
    fontWeight: style.fontWeight,
    textTransform: style.textTransform,
    letterSpacing: style.letterSpacing ? `${style.letterSpacing * pop}px` : undefined,
    color: isActive ? style.activeColor : style.inactiveColor,

    backgroundColor: hasBackground ? background : undefined,
    padding: hasBackground ? scalePxLengths(style.padding ?? "6px 16px", pop) : undefined,
    borderRadius: hasBackground ? `${(style.borderRadius ?? 14) * pop}px` : undefined,
    borderBottom: underline,
    // Keeps the row from shifting when only the active word gains a rule.
    paddingBottom: highlight === "underline" ? Math.round(fontSize * 0.12) : undefined,

    WebkitTextStroke: outlineWidth > 0 ? `${outlineWidth.toFixed(2)}px ${style.outlineColor ?? "#000000"}` : undefined,
    // Stroke behind the fill, so the outline grows outward instead of thinning
    // the glyph. Without this a heavy stroke swallows the letter.
    paintOrder: outlineWidth > 0 ? "stroke fill" : undefined,

    textShadow: shadow,
    boxShadow: hasBackground && isActive ? "0 6px 20px rgba(0,0,0,0.35)" : undefined,

    // Active is the layout size; inactive shrinks back inside its own box.
    transform: isActive ? "scale(1)" : `scale(${(1 / pop).toFixed(4)})`,
    transformOrigin: "center center",
    verticalAlign: "middle",
    zIndex: isActive ? 10 : 1,
  };
}
