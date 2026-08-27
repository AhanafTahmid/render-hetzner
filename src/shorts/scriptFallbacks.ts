/**
 * Script coverage for caption text outside Latin — the ONE definition.
 *
 * ── Why this is its own module ────────────────────────────────────────────────
 *
 * The fallback tail used to live in lib/captionPresets.ts, which lib/captionRender.ts
 * reached through the `@/lib/*` alias. That alias does not exist in the render
 * repo, so the sync script (which vendors lib/captionRender.ts VERBATIM into
 * render-hetzner/src/shorts/) could never carry the import across — and the
 * vendored copy silently stayed on the pre-fallback version of resolveCaptionFont.
 * Result: the browser preview appended the Noto/Baloo tail and drew Bengali,
 * Hindi and Arabic correctly, while the exported MP4 resolved the same caption
 * against a Latin-only stack and drew a tofu box per glyph.
 *
 * So the rule this file exists to enforce: anything lib/captionRender.ts imports
 * must be a RELATIVE sibling import, because `./scriptFallbacks` resolves to
 * lib/scriptFallbacks.ts in the app and to src/shorts/scriptFallbacks.ts in the
 * render repo — the same file, vendored beside it, no alias needed.
 *
 * ── Why a fallback tail rather than picking a font per language ───────────────
 *
 * CSS resolves fonts PER CHARACTER: for each glyph the browser walks the stack
 * and takes the first family that actually has it. Appending script faces to a
 * stack therefore needs no language detection at all, and — the reason it is
 * the right mechanism here rather than merely the cheap one — it handles
 * code-switching, which is the norm in this content. "आपका mindset बदलो" is one
 * line with two scripts in it; Hinglish and Banglish podcasts are full of them.
 * Detecting one language per video and swapping the whole font would render the
 * English half in a Devanagari face, or the Devanagari half in tofu again.
 * Per-glyph resolution gets both halves right in the same word.
 *
 * ── Keeping the style, not just the glyphs ───────────────────────────────────
 *
 * A tail of plain Noto Sans would fix the boxes but throw the look away: the
 * Comic preset would silently become a neutral sans the moment the speaker
 * switched to Hindi. So each family declares a `character`, and the tail is
 * built to match it. The Baloo 2 superfamily is the key: it is one rounded,
 * chunky, comic-adjacent face PER Indic script, plus Arabic — so Comic stays
 * comic in Hindi, Bengali, Tamil, Telugu, Gujarati, Punjabi, Kannada,
 * Malayalam, Odia and Arabic, with Itim covering Thai, Gaegu Korean and Zen
 * Maru Gothic Japanese.
 *
 * Three scripts have no comic-style face on Google Fonts — Chinese, Hebrew and
 * Sinhala. Those fall through the comic tail to the Noto Sans safety net, which
 * is legible and correct, just not playful. There is nothing better to pick.
 *
 * ── Where these families come from ──────────────────────────────────────────
 *   - export:  render-hetzner — Noto via the fonts-noto-* apt packages in the
 *              Dockerfile, Baloo/Itim/Gaegu/Zen Maru Gothic bundled as
 *              webfonts in src/captionFonts.ts
 *   - preview: the Google Fonts @import at the top of app/globals.css
 * A family named here and loaded in neither place silently does nothing, so
 * adding a script means adding it in all three.
 */

/** The visual character a fallback has to preserve, not just the coverage. */
export type FontCharacter = "comic" | "display" | "sans" | "serif" | "mono";

/** Rounded / playful, one per script. Keeps Comic and Bubble on-style. */
const COMIC_SCRIPT_FACES = [
  "Baloo 2",            // Devanagari — Hindi, Marathi, Nepali
  "Baloo Da 2",         // Bengali, Assamese
  "Baloo Bhaijaan 2",   // Arabic, Urdu, Persian
  "Baloo Thambi 2",     // Tamil
  "Baloo Tammudu 2",    // Telugu
  "Baloo Bhai 2",       // Gujarati
  "Baloo Paaji 2",      // Gurmukhi — Punjabi
  "Baloo Tamma 2",      // Kannada
  "Baloo Chettan 2",    // Malayalam
  "Baloo Bhaina 2",     // Odia
  "Itim",               // Thai
  "Gaegu",              // Korean
  "Zen Maru Gothic",    // Japanese
] as const;

/** Legible everywhere. The safety net every tail ends with. */
const NOTO_SCRIPT_FACES = [
  "Noto Sans Devanagari",
  "Noto Sans Bengali",
  "Noto Sans Arabic",
  "Noto Sans Tamil",
  "Noto Sans Telugu",
  "Noto Sans Gujarati",
  "Noto Sans Gurmukhi",
  "Noto Sans Kannada",
  "Noto Sans Malayalam",
  "Noto Sans Oriya",
  "Noto Sans Sinhala",
  "Noto Sans Thai",
  "Noto Sans Hebrew",
  "Noto Sans SC",
  "Noto Sans JP",
  "Noto Sans KR",
  "Noto Color Emoji",   // an emoji in a caption was a tofu box too
  "Noto Sans",          // Latin/Greek/Cyrillic/Vietnamese
] as const;

const quote = (families: readonly string[]) => families.map((f) => `"${f}"`).join(", ");

/**
 * Baloo carries weights to 800, so it doubles as the heavy-display fallback —
 * there is no condensed Indic equivalent of Anton or Bebas Neue to reach for.
 * Serif and mono get the Noto net directly: Noto Serif's per-script coverage is
 * uneven and a monospaced Indic face is not a thing that exists.
 */
const SCRIPT_TAILS: Record<FontCharacter, string> = {
  comic:   `${quote(COMIC_SCRIPT_FACES)}, ${quote(NOTO_SCRIPT_FACES)}, sans-serif`,
  display: `${quote(COMIC_SCRIPT_FACES)}, ${quote(NOTO_SCRIPT_FACES)}, sans-serif`,
  sans:    `${quote(NOTO_SCRIPT_FACES)}, sans-serif`,
  serif:   `${quote(NOTO_SCRIPT_FACES)}, sans-serif`,
  mono:    `${quote(NOTO_SCRIPT_FACES)}, sans-serif`,
};

/**
 * Appends the tail matching this stack's character, once.
 *
 * The trailing generic keyword is dropped first: `serif` or `cursive` sitting
 * before the tail would let the OS answer a Devanagari glyph with whatever it
 * likes, which is the inconsistency between preview and export this is meant to
 * remove. `sans-serif` goes back on the end as the final catch for a script not
 * listed at all (Armenian, Khmer, Ethiopic…), which fontconfig serves out of
 * fonts-noto-core in the container.
 *
 * Applied to custom `fontFamily` values too, so shorts generated before any of
 * this existed pick the coverage up on their next render instead of staying
 * broken until they are re-analysed.
 */
export function withScriptFallbacks(
  stack: string,
  character: FontCharacter = "sans"
): string {
  if (stack.includes("Noto Sans Devanagari")) return stack;
  const trimmed = stack.replace(/,\s*(sans-serif|serif|cursive|monospace)\s*$/i, "");
  return `${trimmed}, ${SCRIPT_TAILS[character]}`;
}
