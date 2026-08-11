/**
 * AI Explainer — the composition.
 *
 * Ported from `remotion/src/scenes/SceneStoryboardPlayer.tsx` in the
 * `video_explainer` reference, with one deliberate change: the scene registry
 * arrives as a prop instead of through a `@project-scenes` webpack alias. The
 * generated scenes for a project are written to a temp directory at render time
 * and imported by a generated entry file, which passes them in here — so no
 * build-time aliasing, and this file stays a normal typechecked module.
 *
 * ## The timing model (the part worth reading twice)
 *
 * Visuals and audio are sequenced separately on purpose.
 *
 * Visuals run through a `TransitionSeries` whose transitions *overlap* their
 * neighbours by TRANSITION_DURATION_FRAMES. If a scene's visual length were
 * just its audio length, the crossfade would start while the narration was
 * still talking. So every non-final scene is padded by exactly the transition
 * length, and the transition then eats that padding — narration finishes, then
 * the crossfade begins.
 *
 * Audio is laid out as plain `<Sequence>`s outside the series, each starting
 * where the previous scene's *unpadded* length ended, so consecutive
 * voiceovers never overlap during a crossfade.
 *
 * Because the padding and the overlap are the same number, they cancel: total
 * duration is simply the sum of (audio + buffer + visual padding), which is
 * what `calculateStoryboardDuration` returns and what the caller must use for
 * `durationInFrames`.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AbsoluteFill,
  Audio,
  Easing,
  interpolate,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { springTiming, TransitionSeries } from "@remotion/transitions";

// Relative, not "@/lib/captions": the render bundles this file with a plain
// webpack config that has none of Next's path aliases (`ae-render-check` fails
// on it), and it is imported from a temp workspace outside the repo.
/**
 * Inlined from the app's `lib/captions.ts`. That module carries server-side
 * caption plumbing this bundle has no use for, and the render only needs the
 * one font stack — kept byte-identical so a caption drawn here matches the
 * dashboard preview exactly.
 */
const COMIC_CAPTION_FONT_STACK = '"Patrick Hand", "Comic Sans MS", cursive';

import { AmbientGlow, PersistentParticles, Vignette } from "./effects";
import { cinematicFade, cinematicSlide } from "./transitions";

// ─── Storyboard shape (mirrors lib/ai-explainer/types.ts) ───────────

export interface AeStoryboardScene {
  id: string;
  /** "<projectId>/<scene_key>"; the key after the slash indexes the registry. */
  type: string;
  title: string;
  /** Absolute URL to the scene's narration audio. */
  audio_file: string;
  audio_duration_seconds: number;
  visual_padding_seconds?: number;
}

export interface AeStoryboard {
  title: string;
  description?: string;
  version?: string;
  project: string;
  video: { width: number; height: number; fps: number };
  style: {
    background_color: string;
    primary_color: string;
    secondary_color: string;
    font_family: string;
  };
  scenes: AeStoryboardScene[];
  audio: {
    buffer_between_scenes_seconds: number;
    background_music?: { url: string; volume?: number } | null;
  };
  /** Opt-in credit card in the bottom-right; absent or disabled draws nothing. */
  watermark?: { enabled: boolean; text: string; url?: string } | null;
  /**
   * Burnt-in subtitles: every spoken word with its position on this
   * composition's clock, in milliseconds. Stamped on the read path by
   * `applyCaptions`, so absent means "no voiceover yet" and disabled means the
   * project turned them off — both draw nothing.
   */
  captions?: { enabled: boolean; words: { text: string; start: number; end: number }[] } | null;
  total_duration_seconds: number;
}

export type AeSceneComponent = React.FC<{ startFrame?: number }>;

export interface AePlayerProps {
  storyboard: AeStoryboard;
  /** scene_key → component, from the generated project's index.ts. */
  scenes: Record<string, AeSceneComponent>;
}

/** ~1.5s at 30fps. Long enough to read as a camera move, not a cut. */
export const TRANSITION_DURATION_FRAMES = 45;

/**
 * The multiplier the composition's own overlays (watermark, captions) size
 * themselves by.
 *
 * These were written as `Math.min(width / 1920, height / 1080)`, which is
 * correct for every 16:9 output and wrong for portrait: a 1080x1920 frame gives
 * `min(0.5625, 1.778)` = 0.5625, shrinking a subtitle to 26px on a 1080-wide
 * video because the frame is not as *wide* as a landscape authoring canvas —
 * which has nothing to do with how big text should be.
 *
 * Keying off the short edge is the same number for every 16:9 size (1920x1080 →
 * 1, 1280x720 → 0.667, 3840x2160 → 2) and the right one for 9:16. The generated
 * `styles.ts` already does the equivalent, because it scales against the
 * project's own canvas rather than a fixed landscape one.
 */
const overlayScale = (width: number, height: number): number =>
  Math.min(width, height) / 1080;

type TransitionStyle =
  | "cinematicFade"
  | "cinematicSlideLeft"
  | "cinematicSlideRight"
  | "cinematicSlideUp"
  | "simpleFade";

// Fades dominate; slides punctuate. Selection is by index so the same
// storyboard always produces the same sequence of transitions.
const TRANSITION_STYLES: TransitionStyle[] = [
  "cinematicFade",
  "cinematicSlideLeft",
  "cinematicFade",
  "cinematicSlideRight",
  "cinematicFade",
  "cinematicSlideUp",
  "simpleFade",
  "cinematicFade",
];

const getTransitionStyle = (sceneIndex: number): TransitionStyle =>
  TRANSITION_STYLES[(sceneIndex * 7 + 3) % TRANSITION_STYLES.length];

const getTransitionPresentation = (style: TransitionStyle, accentColor: string) => {
  switch (style) {
    case "cinematicSlideLeft":
      return cinematicSlide({ slideDirection: "left", accentColor });
    case "cinematicSlideRight":
      return cinematicSlide({ slideDirection: "right", accentColor });
    case "cinematicSlideUp":
      return cinematicSlide({ slideDirection: "up", accentColor });
    case "simpleFade":
      return cinematicFade({
        accentColor,
        enableBlur: false,
        enableLightLeak: false,
        enableChromatic: false,
        enableColorPulse: false,
      });
    case "cinematicFade":
    default:
      return cinematicFade({ accentColor });
  }
};

/**
 * Keeps a scene inside the frame.
 *
 * Scene components are written by a model against a fixed authoring canvas, and
 * the thing it gets wrong most often is size: one column too wide, a stack of
 * cards 60px too tall, a spring that overshoots past the right edge. The prompt
 * argues at length against all three (`scene-prompts.ts`), and the prompt is
 * where the real fix lives — but a prompt is a request, and this is the part
 * that cannot be declined.
 *
 * Two mechanisms, in order:
 *
 *  1. **Shrink to fit.** The scene is measured after layout; if its content is
 *     wider or taller than the frame, the whole scene is scaled down by exactly
 *     the ratio that makes it fit, anchored at the top-left so nothing is pushed
 *     out the other side. A scene 6% too tall gets 6% smaller, which reads as
 *     slightly roomier margins rather than as a mistake.
 *  2. **Clip.** Whatever the measurement cannot see — an element at a negative
 *     offset, something positioned outside the flow — is cut at the frame edge
 *     instead of being composited over the neighbouring scene mid-transition.
 *
 * The measurement is `scrollWidth`/`scrollHeight` on the clipping box itself —
 * two property reads, no DOM walk. Measuring the `overflow: hidden` element is
 * deliberate: that is the case where every browser reports the full extent of
 * the content it is hiding (the same trick as `scrollWidth > clientWidth` for
 * detecting truncated text), whereas the value on an `overflow: visible` box is
 * far less consistent. `useLayoutEffect` runs before paint, so the corrected
 * frame is the one Remotion captures.
 *
 * The scale already applied is divided back out (`fit * width / measured`)
 * because the transformed child contributes to its parent's scroll area — so
 * the measurement is of *scaled* content and the naive ratio would be the
 * correction on top of the correction, converging over several frames instead of
 * landing in one.
 *
 * The correction only ever tightens. A scene that fits at frame 0 and overflows
 * at frame 200 shrinks at frame 200 and stays shrunk: letting it spring back
 * would make the whole frame visibly breathe every time an element animated in,
 * which is a worse artefact than the 4% of size it is holding back. State is
 * per-`<Sequence>`, so each scene starts from 1 again.
 *
 * `MIN_FIT` is the point where "this scene is too big" stops being the likely
 * explanation: content half again the size of the frame is an element
 * deliberately parked outside it (a slide-in start position, an off-screen
 * marker), and shrinking the entire scene to accommodate one is wrong. Those get
 * clipped, which is what they were asking for.
 */
const MIN_FIT = 0.66;

/** There is no layout to measure on the server; only the warning would be real. */
const useMeasureEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const SceneSafeFrame: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { width, height } = useVideoConfig();
  const frame = useCurrentFrame();
  const clip = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);

  useMeasureEffect(() => {
    const node = clip.current;
    if (!node) return;

    const shownWidth = node.scrollWidth;
    const shownHeight = node.scrollHeight;
    if (!shownWidth || !shownHeight) return;

    // `fit *` undoes the scale the measured content is already drawn at, so this
    // is the absolute scale the scene needs, not a further correction.
    const raw = Math.min(1, (fit * width) / shownWidth, (fit * height) / shownHeight);
    // Below the floor, the overflow is deliberate — leave it to the clip.
    const next = raw < MIN_FIT ? 1 : raw;
    // Sub-pixel noise is rounding, not a layout bug; and only ever tighten.
    setFit((current) => (next < current - 0.005 ? next : current));
  }, [frame, width, height, fit]);

  return (
    <AbsoluteFill ref={clip} style={{ overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          transform: fit < 1 ? `scale(${fit})` : undefined,
          transformOrigin: "top left",
        }}
      >
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/**
 * Catches a scene that throws while *rendering* — the failure mode module
 * evaluation cannot see.
 *
 * The scenes are model-written code. `buildAeRegistry` already drops one whose
 * module fails to evaluate, but a scene can evaluate cleanly and still throw on
 * a specific frame — e.g. calling `interpolate()` with an outputRange that
 * works out to NaN ("outputRange must contain only numbers"). Unboundaried,
 * that one frame unwinds the entire `<Player>`: the whole video dies for one
 * scene's bad math, which is exactly the blast radius `MissingScene` exists to
 * prevent for the resolve-time case.
 *
 * State is per-`<TransitionSeries.Sequence>` mount, so a crashed scene stays a
 * card for the rest of its slot and the next scene starts clean. The mp4 render
 * mounts this same composition, so a render survives the same way instead of
 * failing minutes in.
 */
class SceneErrorBoundary extends React.Component<
  { sceneType: string; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error(`[ai-explainer] scene "${this.props.sceneType}" crashed while rendering:`, error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <AbsoluteFill
        style={{
          backgroundColor: "#1a1a2e",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ fontSize: 48, fontWeight: 700, color: "#ffa502", marginBottom: 20 }}>
          Scene Error
        </div>
        <div style={{ fontSize: 24, color: "#888" }}>
          {this.props.sceneType} failed to draw — regenerate this scene
        </div>
      </AbsoluteFill>
    );
  }
}

/** Shown in place of a scene whose registry key does not resolve. */
const MissingScene: React.FC<{ sceneType: string }> = ({ sceneType }) => (
  <AbsoluteFill
    style={{
      backgroundColor: "#1a1a2e",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "sans-serif",
    }}
  >
    <div style={{ fontSize: 48, fontWeight: 700, color: "#ff4757", marginBottom: 20 }}>
      Scene Not Found
    </div>
    <div style={{ fontSize: 24, color: "#888" }}>Missing: {sceneType}</div>
  </AbsoluteFill>
);

/** Looped bed with a 2s fade-in and a 3s fade-out over the whole composition. */
const BackgroundMusic: React.FC<{
  url: string;
  volume: number;
  totalDurationInFrames: number;
}> = ({ url, volume, totalDurationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const fadeIn = interpolate(frame, [0, 2 * fps], [0, volume], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const fadeOut = interpolate(
    frame,
    [totalDurationInFrames - 3 * fps, totalDurationInFrames],
    [volume, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) }
  );

  return (
    <Sequence from={0} durationInFrames={totalDurationInFrames} name="Background Music">
      <Audio src={url} volume={Math.min(fadeIn, fadeOut)} loop />
    </Sequence>
  );
};

/**
 * The opt-in credit card in the bottom-right corner: the video's content title,
 * and its source URL when there is one.
 *
 * This card used to be two separate things — a per-scene "Source" box baked into
 * every generated scene by `referenceTemplate`, and a bottom-centre watermark
 * pill drawn here. That was one element too many: the corner card looked like
 * the watermark, so turning the watermark off left it on screen and the toggle
 * appeared not to work. The pill is gone and this is the watermark, so the
 * toggle removes exactly the thing a viewer would point at.
 *
 * Drawn by the composition rather than by the scenes because the watermark is
 * read from `config` on every preview and render (see `applyWatermark`). Baking
 * it into the generated scene files, as the old source card was, would mean the
 * editor toggle could not take effect without regenerating every scene.
 *
 * Sits above the scenes but below the vignette. Sized from the composition
 * dimensions so it reads the same at 720p and 4k — the renderer scales a
 * 1920x1080 authoring canvas, and a fixed pixel size would shrink to nothing at
 * 480p. Capped in width and clamped to three lines so a long article title
 * cannot grow into a panel across the corner of the video.
 */
const Watermark: React.FC<{ text: string; url?: string; accentColor: string }> = ({
  text,
  url,
  accentColor,
}) => {
  const { width, height } = useVideoConfig();
  const scale = overlayScale(width, height);

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          right: 24 * scale,
          bottom: 24 * scale,
          maxWidth: 340 * scale,
          fontFamily: '"Poppins", -apple-system, BlinkMacSystemFont, sans-serif',
          backgroundColor: "rgba(255, 255, 255, 0.9)",
          borderRadius: 8 * scale,
          padding: `${8 * scale}px ${12 * scale}px`,
          border: `1px solid rgba(0, 0, 0, 0.08)`,
          boxShadow: "0 2px 8px rgba(0, 0, 0, 0.08)",
        }}
      >
        <div
          style={{
            fontSize: 9 * scale,
            fontWeight: 600,
            color: "rgba(26, 26, 26, 0.45)",
            textTransform: "uppercase",
            letterSpacing: 0.5 * scale,
            marginBottom: 4 * scale,
          }}
        >
          Source
        </div>
        {text ? (
          <div
            style={{
              fontSize: 11 * scale,
              fontWeight: 600,
              color: "rgba(26, 26, 26, 0.75)",
              lineHeight: 1.35,
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 3,
              overflow: "hidden",
            }}
          >
            {text}
          </div>
        ) : null}
        {url ? (
          <div
            style={{
              fontSize: 9 * scale,
              color: accentColor,
              lineHeight: 1.4,
              marginTop: text ? 3 * scale : 0,
              wordBreak: "break-all",
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 2,
              overflow: "hidden",
            }}
          >
            {url}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

/** Words shown together in one caption group — mirrors DEFAULT_WORDS_PER_BATCH. */
export const AE_WORDS_PER_CAPTION = 4;

interface CaptionGroup {
  text: string;
  /** Frames on the composition's clock. */
  from: number;
  durationInFrames: number;
}

/**
 * Word timings → the caption groups actually drawn.
 *
 * Words arrive one at a time because that is what the speech recogniser
 * returns, and one word at a time is unreadable — it reads as a strobe. They
 * are grouped into phrases of AE_WORDS_PER_CAPTION, and each group is shown
 * from its first word's start until its last word's end.
 *
 * Two adjustments make it hold still rather than flicker:
 *
 *  - A group is held for a minimum of `MIN_FRAMES`. Four quick words can span
 *    less than a third of a second, which is long enough to notice and too
 *    short to read.
 *  - A gap shorter than `BRIDGE_FRAMES` between consecutive groups is closed by
 *    extending the earlier one. Natural speech leaves 100-200ms between
 *    phrases, and blanking the caption across every one of those makes the
 *    subtitle blink through the whole video.
 *
 * Groups never overlap: an extension is always clamped to the next group's
 * start, so two captions cannot be on screen at once.
 */
export function buildCaptionGroups(
  words: { text: string; start: number; end: number }[],
  fps: number,
  wordsPerCaption: number = AE_WORDS_PER_CAPTION
): CaptionGroup[] {
  const MIN_FRAMES = Math.round(fps * 0.5);
  const BRIDGE_FRAMES = Math.round(fps * 0.4);
  const size = Math.max(1, wordsPerCaption);

  const msToFrames = (ms: number) => Math.round((ms / 1000) * fps);

  const raw: { text: string; from: number; to: number }[] = [];
  for (let i = 0; i < words.length; i += size) {
    const batch = words.slice(i, i + size);
    const text = batch
      .map((w) => w.text.trim())
      .filter(Boolean)
      .join(" ");
    if (!text) continue;

    const from = msToFrames(batch[0].start);
    const to = msToFrames(batch[batch.length - 1].end);
    raw.push({ text, from, to: Math.max(to, from + 1) });
  }

  return raw.map((group, index) => {
    const next = raw[index + 1];
    // Hold long enough to read, and bridge the pause before the next phrase —
    // but never past where the next caption begins.
    let end = Math.max(group.to, group.from + MIN_FRAMES);
    if (next && next.from - group.to <= BRIDGE_FRAMES) end = Math.max(end, next.from);
    if (next) end = Math.min(end, next.from);

    return {
      text: group.text,
      from: group.from,
      durationInFrames: Math.max(1, end - group.from),
    };
  });
}

/**
 * Burnt-in subtitles along the bottom of the frame.
 *
 * Drawn last of everything, above the vignette — see the call site. Sized and
 * positioned from the composition rather than in fixed pixels, for the same
 * reason the watermark is: the renderer scales a 1920x1080 authoring canvas,
 * and fixed sizes vanish at 480p.
 *
 * Drawn with a text stroke rather than a background plate. A plate is a solid
 * bar across the bottom of every frame of the video; a stroke keeps the artwork
 * visible behind the words and still reads against both the light and dark
 * backgrounds a scene might use. `paintOrder: "stroke"` puts the outline behind
 * the glyph so the letterforms stay sharp instead of being eaten from outside.
 *
 * Each group is its own `<Sequence>`, so Remotion mounts exactly one caption at
 * a time and the render does no per-frame searching through the word list.
 */
const Captions: React.FC<{ words: { text: string; start: number; end: number }[] }> = ({
  words,
}) => {
  const { width, height, fps } = useVideoConfig();
  const scale = overlayScale(width, height);
  const groups = React.useMemo(() => buildCaptionGroups(words, fps), [words, fps]);

  if (!groups.length) return null;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {groups.map((group, index) => (
        <Sequence
          key={`caption-${index}`}
          from={group.from}
          durationInFrames={group.durationInFrames}
          name={`Caption: ${group.text.slice(0, 24)}`}
          layout="none"
        >
          <div
            style={{
              position: "absolute",
              left: "8%",
              right: "8%",
              // Clear of the watermark card in the bottom-right corner.
              bottom: 132 * scale,
              textAlign: "center",
              // The app-wide default caption face — see `lib/captions.ts`. Not
              // the scene font: subtitles should read the same across every
              // template, whatever palette a project's scenes use.
              fontFamily: COMIC_CAPTION_FONT_STACK,
              fontSize: 46 * scale,
              fontWeight: 700,
              lineHeight: 1.25,
              color: "#FBBF24",
              WebkitTextStrokeWidth: 6 * scale,
              WebkitTextStrokeColor: "rgba(0, 0, 0, 0.92)",
              paintOrder: "stroke",
              textShadow: `0 ${3 * scale}px ${10 * scale}px rgba(0, 0, 0, 0.55)`,
            }}
          >
            {group.text}
          </div>
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

export const AeSceneStoryboardPlayer: React.FC<AePlayerProps> = ({ storyboard, scenes }) => {
  const { fps } = useVideoConfig();
  const buffer = storyboard.audio?.buffer_between_scenes_seconds ?? 1.0;

  const sceneData = storyboard.scenes.map((scene, index) => {
    const visualPadding = scene.visual_padding_seconds ?? 0;
    const baseDurationInFrames = Math.ceil(
      (scene.audio_duration_seconds + buffer + visualPadding) * fps
    );
    const isLastScene = index === storyboard.scenes.length - 1;
    // Padding that the following transition will consume — see the header note.
    const transitionPadding = isLastScene ? 0 : TRANSITION_DURATION_FRAMES;

    const key = scene.type.split("/").pop() ?? scene.type;

    return {
      ...scene,
      durationInFrames: baseDurationInFrames + transitionPadding,
      SceneComponent: scenes[key],
    };
  });

  const totalDurationInFrames =
    sceneData.reduce((sum, s) => sum + s.durationInFrames, 0) -
    Math.max(0, sceneData.length - 1) * TRANSITION_DURATION_FRAMES;

  const backgroundMusic = storyboard.audio?.background_music;
  const accentColor = storyboard.style?.primary_color || "#0066FF";

  return (
    <AbsoluteFill style={{ backgroundColor: storyboard.style?.background_color || "#FAFAFA" }}>
      {backgroundMusic?.url && (
        <BackgroundMusic
          url={backgroundMusic.url}
          volume={backgroundMusic.volume ?? 0.1}
          totalDurationInFrames={totalDurationInFrames}
        />
      )}

      <AmbientGlow color={accentColor} intensity={0.12} />

      {/* Visuals: overlapping transitions. */}
      <TransitionSeries>
        {sceneData.map((scene, index) => {
          const isLastScene = index === sceneData.length - 1;
          return (
            <React.Fragment key={scene.id}>
              <TransitionSeries.Sequence durationInFrames={scene.durationInFrames}>
                <SceneSafeFrame>
                  {scene.SceneComponent ? (
                    <SceneErrorBoundary sceneType={scene.type}>
                      <scene.SceneComponent startFrame={0} />
                    </SceneErrorBoundary>
                  ) : (
                    <MissingScene sceneType={scene.type} />
                  )}
                </SceneSafeFrame>
              </TransitionSeries.Sequence>

              {!isLastScene && (
                <TransitionSeries.Transition
                  presentation={getTransitionPresentation(getTransitionStyle(index), accentColor)}
                  timing={springTiming({
                    config: { damping: 200 },
                    durationInFrames: TRANSITION_DURATION_FRAMES,
                    durationRestThreshold: 0.001,
                  })}
                />
              )}
            </React.Fragment>
          );
        })}
      </TransitionSeries>

      {/* Audio: sequential, never overlapping across a crossfade. */}
      {(() => {
        let audioStartFrame = 0;
        return sceneData.map((scene, index) => {
          const currentStart = audioStartFrame;
          const audioDurationFrames = Math.ceil(scene.audio_duration_seconds * fps);
          const isLastScene = index === sceneData.length - 1;
          audioStartFrame +=
            scene.durationInFrames - (isLastScene ? 0 : TRANSITION_DURATION_FRAMES);

          if (!scene.audio_file) return null;

          return (
            <Sequence
              key={`audio-${scene.id}`}
              from={currentStart}
              durationInFrames={audioDurationFrames + Math.ceil(buffer * fps)}
              name={`Audio: ${scene.title}`}
            >
              <Audio src={scene.audio_file} volume={1} />
            </Sequence>
          );
        });
      })()}

      <PersistentParticles count={25} color="#ffffff" seed="cinematic-dust" />

      {storyboard.watermark?.enabled && (storyboard.watermark.text || storyboard.watermark.url) ? (
        <Watermark
          text={storyboard.watermark.text}
          url={storyboard.watermark.url}
          accentColor={accentColor}
        />
      ) : null}

      <Vignette intensity={0.35} />

      {/* Last, so it is over the vignette rather than under it. The vignette
          darkens the frame's edges most strongly, and the bottom edge is
          exactly where a subtitle sits — drawn underneath, every caption would
          be dimmed by the one effect aimed at where it lives. */}
      {storyboard.captions?.enabled && storyboard.captions.words?.length ? (
        <Captions words={storyboard.captions.words} />
      ) : null}
    </AbsoluteFill>
  );
};

/**
 * Total seconds for the storyboard. The transition padding added to each scene
 * and the overlap consumed by each transition are the same value, so they
 * cancel and the total is just the sum of the parts.
 *
 * Must agree with what the player lays out, or the render is cut short.
 */
export function calculateStoryboardDuration(storyboard: AeStoryboard): number {
  const buffer = storyboard.audio?.buffer_between_scenes_seconds ?? 1.0;
  return storyboard.scenes.reduce(
    (sum, s) => sum + s.audio_duration_seconds + buffer + (s.visual_padding_seconds ?? 0),
    0
  );
}

export default AeSceneStoryboardPlayer;
