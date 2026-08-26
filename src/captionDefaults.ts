/**
 * The caption defaults, mirrored from vidgpt/lib/captions.ts.
 *
 * Why this file exists: both compositions here carried their own fallbacks —
 * `fontFamily: "system-ui"` and `wordsPerBatch: 1` — while the app resolved the
 * same fallbacks from lib/captions.ts as Patrick Hand at 4 words. A video with
 * no stored caption style therefore previewed in the comic face, four words at a
 * time, and exported in a generic sans, one word at a time. lib/captions.ts was
 * written to end exactly that class of split and never reached this repo.
 *
 * Keep in sync with vidgpt/lib/captions.ts. Only the values a composition needs
 * are here; the visibility helpers stay app-side.
 */

/** Words shown together in one caption group. */
export const DEFAULT_WORDS_PER_BATCH = 4;

/**
 * The default caption face. Patrick Hand is vendored through
 * @fontsource/patrick-hand and imported by the compositions, so it is bundled
 * into the render rather than hoped for; Comic Sans stays behind it as the
 * fallback for a surface that has not loaded the webfont. This container has no
 * system fonts at all, which is why leading with Comic Sans MS produced a
 * generic sans in every exported MP4.
 */
export const COMIC_CAPTION_FONT_STACK = '"Patrick Hand", "Comic Sans MS", cursive';

/** The style a video's captions take when nothing has overridden them. */
export const DEFAULT_CAPTION_STYLE = {
  preset: "comic",
  fontSize: 72,
  fontWeight: 700,
  fontFamily: COMIC_CAPTION_FONT_STACK,
  textTransform: "none" as const,
  activeColor: "#FBBF24",
  inactiveColor: "#D4A017",
  positionBottom: 5,
  wordsPerBatch: DEFAULT_WORDS_PER_BATCH,
  layout: "inline" as const,
  showEmojis: false,
};
