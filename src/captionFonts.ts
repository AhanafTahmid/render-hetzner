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
