/**
 * AI Explainer — fonts bundled into the render.
 *
 * The reference app loads Outfit through `@remotion/google-fonts`, which is not
 * a dependency here and would fetch at render time. Poppins is the closest
 * geometric sans already vendored in this repo, and the generated `styles.ts`
 * puts it first in its font stack — so importing it here is what makes that
 * stack resolve to a real face instead of falling through to the system sans.
 *
 * Imported by the generated render entry point, never by the Next app.
 */

import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
// The subtitle face. Bundled rather than assumed: the render container has no
// Comic Sans, so without this the mp4's captions would fall back to a generic
// sans while the browser preview drew a hand-drawn one.
import "@fontsource/patrick-hand";

export const AE_FONT_FAMILY = '"Poppins", -apple-system, BlinkMacSystemFont, sans-serif';
