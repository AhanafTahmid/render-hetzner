/**
 * The caption typefaces, bundled.
 *
 * A side-effect import: pulling this module in registers every @font-face the
 * caption presets can name. Anything that draws a caption must import it, or the
 * preset's `fontFamily` falls through to the stack's OS fallback — which in the
 * render container (Chromium libraries, no font packages) means the same
 * fallback face for all of them.
 *
 * This is the mechanism the codebase already uses for template fonts; see
 * remotion/fonts/registry.ts and remotion/templates/ai-explainer/fonts.ts.
 *
 * The weights here must match CAPTION_FONTS in lib/captionPresets.ts exactly.
 * Importing a weight no preset uses is dead bytes in every render; missing one a
 * preset does use makes the browser synthesise a fake bold, which looks wrong
 * next to the real weight in the same line.
 *
 * VERBATIM COPY of vidgpt/lib/captionFonts.ts.
 */

// Inter — the neutral grotesque behind Default, Clean, Modern, Glass, Banner.
import "@fontsource/inter/500.css";
import "@fontsource/inter/900.css";
// Montserrat — Karaoke, Spotlight, Active, Glow, Blue.
import "@fontsource/montserrat/700.css";
import "@fontsource/montserrat/900.css";
// Poppins — Umi, Ariel, Pastel, Slow, Coral.
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/800.css";
// Anton — the condensed display face behind Statement, BEAST, Red.
import "@fontsource/anton/400.css";
// Bebas Neue — Hype.
import "@fontsource/bebas-neue/400.css";
// Archivo Black — Punch, Mark, Neon, Vivid.
import "@fontsource/archivo-black/400.css";
// Luckiest Guy — Comic, Bubble.
import "@fontsource/luckiest-guy/400.css";
// Permanent Marker — Marker.
import "@fontsource/permanent-marker/400.css";
// Playfair Display — Editorial, Story, Classic, Elegant.
import "@fontsource/playfair-display/700.css";
// Space Mono — Vapor, RetroTV.
import "@fontsource/space-mono/700.css";

/* ── Script coverage for the caption faces above ───────────────────────────────
 *
 * Everything above is Latin-only; Poppins adds Devanagari and nothing else. Noto
 * arrives as system fonts (fonts-noto-core / -cjk / -color-emoji, installed in
 * the Dockerfile) and covers every script legibly, so the tofu boxes are gone
 * either way.
 *
 * These, though, are what keep the STYLE. The Baloo 2 superfamily is one
 * rounded, comic-adjacent face per Indic script plus Arabic, so the Comic,
 * Bubble and Default presets stay comic when the speaker switches to Hindi or
 * Bengali instead of quietly turning into a neutral sans. Itim does the same for
 * Thai, Gaegu for Korean, Zen Maru Gothic for Japanese. They are not Debian
 * packages, so unlike Noto they have to be bundled here.
 *
 * 400 and 700 only: the comic presets ask for 400, the heavy-display tail wants
 * a bold, and every extra weight is bytes in every render. Weights the packages
 * do not ship (Itim is 400-only) are simply not imported — importing a missing
 * one fails the bundle.
 *
 * Keep this list in step with COMIC_SCRIPT_FACES in the app's
 * lib/captionPresets.ts. A face named in the stack but not loaded here is
 * skipped silently at render time, which reads as the fix not working. */
// Devanagari — Hindi, Marathi, Nepali
import "@fontsource/baloo-2/400.css";
import "@fontsource/baloo-2/700.css";
// Bengali, Assamese
import "@fontsource/baloo-da-2/400.css";
import "@fontsource/baloo-da-2/700.css";
// Arabic, Urdu, Persian
import "@fontsource/baloo-bhaijaan-2/400.css";
import "@fontsource/baloo-bhaijaan-2/700.css";
// Tamil
import "@fontsource/baloo-thambi-2/400.css";
import "@fontsource/baloo-thambi-2/700.css";
// Telugu
import "@fontsource/baloo-tammudu-2/400.css";
import "@fontsource/baloo-tammudu-2/700.css";
// Gujarati
import "@fontsource/baloo-bhai-2/400.css";
import "@fontsource/baloo-bhai-2/700.css";
// Gurmukhi — Punjabi
import "@fontsource/baloo-paaji-2/400.css";
import "@fontsource/baloo-paaji-2/700.css";
// Kannada
import "@fontsource/baloo-tamma-2/400.css";
import "@fontsource/baloo-tamma-2/700.css";
// Malayalam
import "@fontsource/baloo-chettan-2/400.css";
import "@fontsource/baloo-chettan-2/700.css";
// Odia
import "@fontsource/baloo-bhaina-2/400.css";
import "@fontsource/baloo-bhaina-2/700.css";
// Thai — 400 is the only weight shipped
import "@fontsource/itim/400.css";
// Korean
import "@fontsource/gaegu/400.css";
import "@fontsource/gaegu/700.css";
// Japanese
import "@fontsource/zen-maru-gothic/400.css";
import "@fontsource/zen-maru-gothic/700.css";
