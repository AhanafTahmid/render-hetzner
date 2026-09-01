/**
 * The hook title — the headline burned over the first seconds of a clip.
 *
 * A clip that opens on a sentence fragment gives a scrolling viewer nothing to
 * decide on. The hook is the decision: one line at the top of the frame saying
 * what the next 40 seconds are about. Every model already writes one per clip
 * (`viral_hook_text`, stored as `hookText`); until now nothing drew it.
 *
 * This module is the ONLY definition of what a hook looks like. It is imported
 * by three very different consumers:
 *
 *   - components/RemotionShortPlayer.tsx — the editor preview AND, via
 *     scripts/sync-render-composition.mjs, the render server's composition.
 *   - components/dashboard/UploadVideo.tsx — the per-upload picker.
 *   - app/dashboard/settings — the account-wide default picker.
 *   - the API routes, which re-validate whatever the client sends.
 *
 * It therefore imports nothing but `./scriptFallbacks`, with a RELATIVE path.
 * It is vendored verbatim into the render repo
 * (as src/shorts/hookTitle.ts) by the sync script, and a vendored file cannot
 * resolve the `@/` alias — the same constraint that already shapes
 * lib/splitLayout.ts and lib/captionRender.ts. `./scriptFallbacks` is the one
 * import that survives the move, because it is vendored into the SAME directory.
 * Keep it otherwise dependency-free and free of anything server-only; it ships
 * in a client bundle too.
 */

import { withScriptFallbacks } from "./scriptFallbacks";

export type HookStyleId = "card" | "block";

export interface HookStyleMeta {
  id: HookStyleId;
  name: string;
  /** One line for the picker, describing the look rather than the mechanism. */
  hint: string;
  /**
   * Colour the swatches start from when this style is picked, and the colour a
   * project falls back to if its stored one is unusable. They differ because
   * the colour means opposite things in the two styles: the card is a light
   * surface behind dark text, the block is a saturated fill under white text.
   */
  defaultColor: string;
}

export const HOOK_STYLES: HookStyleMeta[] = [
  {
    id: "card",
    name: "Card",
    hint: "One rounded panel, sentence case",
    defaultColor: "#ffffff",
  },
  {
    id: "block",
    name: "Block",
    hint: "Filled bars behind each line, uppercase",
    defaultColor: "#22c55e",
  },
];

export const DEFAULT_HOOK_STYLE: HookStyleId = "card";
export const DEFAULT_HOOK_COLOR = "#ffffff";

/**
 * Swatches offered in the pickers. Not a limit — both pickers also expose a
 * free colour input, and `sanitizeHookColor` accepts any valid hex — just the
 * eight that cover almost every channel's palette without opening a dialog.
 */
export const HOOK_COLORS: readonly string[] = [
  "#ffffff",
  "#000000",
  "#22c55e",
  "#ff6a00",
  "#fde047",
  "#3b82f6",
  "#ec4899",
  "#ef4444",
];

/**
 * How long the hook stays on screen: a whole number of seconds, or the whole clip.
 *
 * Stored as a STRING even for the numeric options, so one field holds both kinds
 * of answer and no magic number has to stand in for "full". A `0`-means-full
 * encoding would sit next to `hookTitleEnabled` in the same document and read as
 * "off" to anyone skimming, which is exactly the confusion worth paying a string
 * to avoid.
 */
export type HookDuration = "2" | "3" | "4" | "5" | "full";

export const HOOK_DURATIONS: readonly HookDuration[] = ["2", "3", "4", "5", "full"];

/**
 * Three seconds, by default.
 *
 * Long enough to read one line and decide, then out of the way — the top of the
 * frame is where a lot of podcast footage puts the speaker's head, and covering a
 * face for forty seconds costs more than it buys. "full" is one click away for
 * anyone who wants the scroller arriving late to see it too.
 *
 * Note this is a DURATION default and says nothing about the start: the hook is
 * at full opacity on frame 0 either way. Those two got conflated once — the
 * default was briefly "full" on the reading that "floats from the start" meant
 * "never leaves" — and the distinction is worth keeping separate, because the
 * frame-0 guarantee is not negotiable while the duration always was.
 */
export const DEFAULT_HOOK_DURATION: HookDuration = "3";

/**
 * Accepts the string form the UI sends AND a bare number, because a JSON body is
 * free to carry `"hookDuration": 3`. Without the coercion that fell through to
 * the default — meaning a client asking for 3 seconds silently got the whole
 * clip, with nothing anywhere saying so. Trimmed too, so `" 3"` is not a
 * different answer from `"3"`.
 */
export function sanitizeHookDuration(value: unknown): HookDuration {
  const candidate =
    typeof value === "number" && Number.isFinite(value)
      ? String(Math.round(value))
      : typeof value === "string"
        ? value.trim().toLowerCase()
        : value;
  return HOOK_DURATIONS.includes(candidate as HookDuration)
    ? (candidate as HookDuration)
    : DEFAULT_HOOK_DURATION;
}

/** Label for the pickers. Numeric options get a unit; "full" gets a phrase. */
export function hookDurationLabel(duration: HookDuration): string {
  return duration === "full" ? "Full clip" : `${duration}s`;
}

/**
 * How many frames the hook is drawn for.
 *
 * Clamped to the clip's own length, so a 5-second setting on a 3-second short
 * shows the hook for the whole 3 seconds rather than reaching past the last
 * frame — and so "full" and "longer than the clip" collapse to the same answer.
 *
 * There is NO FADE at either end, by request: the hook is at full opacity on
 * frame 0 and cuts out in one frame when its time is up. Frame 0 is the
 * thumbnail, the frame a paused player shows and the frame a scroller sees
 * first, and the previous version faded IN from zero — so the hook was invisible
 * at precisely the moment it exists for. Trading a soft exit for a guaranteed
 * entrance is the deliberate half of that; a hook set to less than the full clip
 * will visibly pop out.
 */
export function hookVisibleFrames(
  duration: HookDuration,
  fps: number,
  durationInFrames: number
): number {
  if (duration === "full") return durationInFrames;
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds <= 0) return durationInFrames;
  return Math.min(durationInFrames, Math.round(seconds * fps));
}

/**
 * A title the pipeline writes when the model gave it nothing usable. Drawing it
 * as a hook would put the words "Untitled Clip" across the top of the video,
 * which is worse than drawing nothing — so it is treated as absent.
 */
const PLACEHOLDER_TITLES = new Set(["untitled clip", "untitled", "clip"]);

/**
 * Hard ceiling on what gets drawn, in characters.
 *
 * The prompt asks for under 60, which a real hook comfortably meets. This is not
 * for the hook — it is for the TITLE FALLBACK. A YouTube Shorts title is allowed
 * 100 characters, and at the smallest step of the font ramp 100 characters is
 * five lines across the top third of the frame, over the speaker's face, for
 * three seconds. 90 leaves every genuine hook untouched and clips only the
 * longest titles.
 */
export const HOOK_MAX_CHARS = 90;

/**
 * Trim to HOOK_MAX_CHARS at a word boundary.
 *
 * The ellipsis is added ONLY when something was actually cut, and it is there on
 * purpose: a sentence that stops mid-thought with no mark reads as a rendering
 * bug, while one that stops with a mark reads as a deliberate tease. Falls back
 * to a hard slice for a single unbroken 90-character token, which is not English
 * but is the kind of thing a transcript of a URL produces.
 */
function clampHookLength(text: string): string {
  if (text.length <= HOOK_MAX_CHARS) return text;
  const cut = text.slice(0, HOOK_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > HOOK_MAX_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut;
  return body.replace(/[\s,;:.!?-]+$/, "") + "…";
}

/**
 * Clean up one hook string as the model wrote it.
 *
 * Everything here is a failure mode actually worth guarding, given the model is
 * deepseek-v4-flash with reasoning DISABLED (see config/ai.ts) — the regime where
 * a secondary field comes back decorated or quoted rather than plain. Applied at
 * write time in the pipeline AND on read, because the rows written before any of
 * this existed have had none of it:
 *
 *   - Wrapping quotes. `"Stop doing this!"` drawn literally puts quote marks on
 *     the video, and the prompt's own example is quoted, which invites it.
 *   - Newlines and runs of spaces. The overlay wraps text itself; a newline the
 *     model chose fights the box width and strands one word on a line.
 *   - A trailing full stop, comma or ellipsis. A period at the end of type this
 *     size reads as a typo; a question or exclamation mark is meaning and stays.
 *   - Markdown asterisks, which json_object mode does not prevent.
 */
export function normalizeHookText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let text = raw.replace(/\s+/g, " ").trim();
  // Repeatedly, because `""Stop this""` and `"'Stop this'"` both occur.
  for (let i = 0; i < 3; i++) {
    const unwrapped = text.replace(/^["'“”‘’*]+|["'“”‘’*]+$/g, "").trim();
    if (unwrapped === text) break;
    text = unwrapped;
  }
  // Only the marks that carry no meaning. `?` and `!` are the hook's whole tone.
  text = text.replace(/[.,;:\u2026]+$/g, "").trim();
  return clampHookLength(text);
}

/**
 * The words to draw for a clip, or "" for nothing.
 *
 * `hookText` first because it is written FOR this job: max ten words, in the
 * transcript's own language, phrased as a hook. `title` is the fallback for
 * clips generated before hooks were stored — it is a YouTube listing title, so
 * it is longer and less punchy, but it is still a true description of the clip
 * and better than an empty frame.
 */
export function resolveHookText(short: {
  hookText?: string | null;
  title?: string | null;
}): string {
  const hook = normalizeHookText(short.hookText);
  if (hook) return hook;
  const title = normalizeHookText(short.title);
  if (!title || PLACEHOLDER_TITLES.has(title.toLowerCase())) return "";
  return title;
}

/**
 * A project's hook choice, as stored on the Project document.
 *
 * `enabled` off, or the whole object missing, both mean "no hook" — see
 * resolveHookProps for why those two must be indistinguishable.
 */
export interface HookConfig {
  enabled?: boolean | null;
  style?: string | null;
  color?: string | null;
  duration?: string | null;
}

/**
 * The three props the composition needs, or undefined for "draw nothing".
 *
 * THE one place that decision is made, called by everything that renders a
 * short: lib/shortRenderInput.ts (the export payload and its fingerprint),
 * components/RemotionShortPlayer.tsx (the project page's clip player) and
 * app/editor/[shortId] (the editor preview). It lives here, not in
 * shortRenderInput.ts, for a mechanical reason worth stating: that module
 * imports node:crypto, so a client component cannot touch it.
 *
 * Undefined collapses four different situations that must all render
 * identically: the project has hooks off, the caller passed no config at all,
 * the config is there but its text is empty, and the clip predates hooks with
 * nothing but a placeholder title. Collapsing them HERE rather than at each
 * caller is what keeps the export fingerprint honest — "hook on with nothing to
 * draw" has to hash the same as "hook off", because it renders the same pixels,
 * and a hash that differs would charge the user for an identical re-render.
 */
export function resolveHookProps(
  config: HookConfig | null | undefined,
  short: { hookText?: string | null; title?: string | null }
):
  | { hookText: string; hookStyle: HookStyleId; hookColor: string; hookDuration: HookDuration }
  | undefined {
  if (!config?.enabled) return undefined;
  const hookText = resolveHookText(short);
  if (!hookText) return undefined;
  return {
    hookText,
    hookStyle: sanitizeHookStyle(config.style),
    hookColor: sanitizeHookColor(config.color),
    hookDuration: sanitizeHookDuration(config.duration),
  };
}

/** Any 3- or 6-digit hex colour, with the hash. Anything else is not a colour. */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function sanitizeHookStyle(value: unknown): HookStyleId {
  return value === "block" || value === "card" ? value : DEFAULT_HOOK_STYLE;
}

export function sanitizeHookColor(value: unknown, fallback = DEFAULT_HOOK_COLOR): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  // Lower-cased so two spellings of the same colour cannot produce two
  // different export fingerprints and charge someone for an identical re-render.
  return HEX.test(trimmed) ? trimmed.toLowerCase() : fallback;
}

/** #abc → #aabbcc, so one parser handles both forms. */
function expandHex(hex: string): string {
  if (hex.length !== 4) return hex;
  return "#" + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
}

/**
 * Perceived brightness of a colour, 0 (black) to 1 (white).
 *
 * Relative luminance per WCAG, including the sRGB gamma step. The cheap
 * average-of-channels version rates pure green at 0.5 and would put dark text
 * on it; the gamma-correct version rates it 0.72, which is why the green block
 * in the reference screenshot correctly wants WHITE text.
 */
export function hookLuminance(color: string): number {
  const hex = expandHex(color.trim().toLowerCase());
  if (!/^#[0-9a-f]{6}$/.test(hex)) return 1;
  const channel = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/**
 * Text colour for a given fill.
 *
 * Derived rather than configurable on purpose: the pickers offer one colour, and
 * a second control for the text is how you end up with white on yellow. The
 * threshold sits at 0.42 rather than 0.5 because white text holds up on a
 * mid-tone better than black does — black on a medium blue is the pairing that
 * fails first.
 */
export function hookTextColor(fill: string): string {
  return hookLuminance(fill) > 0.42 ? "#101014" : "#ffffff";
}

/**
 * Font size for the hook, in composition pixels, chosen from how much text
 * there is.
 *
 * A ramp rather than measured text: Remotion renders each frame in isolation and
 * measuring a DOM node to then re-render at a new size costs a layout pass per
 * frame and still cannot be done during the render server's headless pass. The
 * breakpoints are set so the longest hook the model is allowed to write (ten
 * words, ~70 characters) lands on three lines inside the box below.
 *
 * Scaled by the composition width so the same numbers work at 1080 and in the
 * small preview player.
 */
export function hookFontSize(text: string, compositionWidth: number): number {
  const n = text.trim().length;
  const base = n <= 24 ? 82 : n <= 40 ? 72 : n <= 58 ? 62 : n <= 80 ? 54 : 46;
  return (base * compositionWidth) / 1080;
}

/**
 * The typeface for each style, and its weight.
 *
 * Restricted to the families the render container actually has. That container
 * installs no fonts of its own: everything is loaded explicitly by
 * render-hetzner/src/captionFonts.ts (and by the @import in app/globals.css on
 * this side), so a family outside that set renders in the same anonymous
 * fallback in the EXPORT while looking correct in a macOS browser preview. That
 * is the exact bug the caption preset table's header documents; the hook is not
 * going to reintroduce it.
 *
 * Montserrat 700 for the card because it is a clean humanist sans at a weight
 * that reads as a headline without shouting; Archivo Black for the block because
 * a filled bar needs a face heavy enough to hold the fill.
 *
 * `withScriptFallbacks` appends the Noto/Baloo tail, so a Bengali or Arabic hook
 * gets real glyphs instead of tofu boxes — the same treatment captions get.
 */
export function hookFont(style: HookStyleId): { stack: string; weight: number } {
  return style === "block"
    ? {
        stack: withScriptFallbacks(`"Archivo Black", "Arial Black", sans-serif`, "display"),
        weight: 400,
      }
    : {
        stack: withScriptFallbacks(`"Montserrat", system-ui, sans-serif`, "sans"),
        weight: 700,
      };
}
