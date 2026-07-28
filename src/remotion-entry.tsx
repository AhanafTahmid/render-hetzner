import React from "react";
import { registerRoot, Composition } from "remotion";
// vidshero — editor preview component (app/dashboard/_components/RemotionVideo.tsx)
import RemotionVideo from "./compositions/RemotionVideo";
import { WeddingVideo } from "./compositions/WeddingVideo";
// shortshero — ShortComposition extracted from components/RemotionShortPlayer.tsx
import { ShortComposition } from "./compositions/ShortVideo";
// vidgpt — editor preview components (app/dashboard/_components/{RemotionVideo,BlogTemplatePlayer}.tsx)
import VidgptVideo from "./compositions/VidgptVideo";
import { BlogTemplatePlayer } from "./compositions/BlogTemplatePlayer";
import { DEFAULT_COMPOSITION_ID } from "./constants";

// Render-time metadata is carried in inputProps by every caller (durationInFrames,
// width, height are sent alongside the editor data), so calculateMetadata reads
// them directly — keeping the export frame-identical to the editor preview.
type SizedProps = { durationInFrames?: number; width?: number; height?: number };

// ─────────────────────────────────────────────────────────────────────────────
// Unified render root. One worker ("render") serves every product, and each
// composition IS the app's editor-preview component so the export === preview:
//   id "vidshero"      → vidshero feed/export video   (vidshero)
//   id "WeddingVideo"  → vidshero wedding template     (vidshero)
//   id "render"        → short-form clip export        (shortshero)
//   id "vidgpt"        → vidgpt feed/export video      (vidgpt)
//   id "blog-template" → vidgpt themed blog templates  (vidgpt)
// ─────────────────────────────────────────────────────────────────────────────

const RemotionRoot = () => (
  <>
    {/* ── vidshero ───────────────────────────────────────────────────────── */}
    <Composition
      id={DEFAULT_COMPOSITION_ID}
      component={RemotionVideo}
      calculateMetadata={({ props }) => {
        const fps = 30;
        const p = props as SizedProps;
        const durationInFrames = Math.max(1, p.durationInFrames ?? 1);
        const width = p.width ?? 1080;
        const height = p.height ?? 1920;
        return { durationInFrames, fps, width, height };
      }}
      durationInFrames={1}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{
        script: [],
        audioFileUrl: "",
        musicUrl: "",
        voiceoverVolume: 1,
        musicVolume: 0.35,
        captions: [],
        imageList: [],
        clipList: [],
        clipDurations: [],
        voiceoverSegments: [],
        extraTracks: [],
        showWatermark: false,
        captionsVisible: true,
        durationInFrames: 1,
        width: 1080,
        height: 1920,
      }}
    />
    <Composition
      id="WeddingVideo"
      component={WeddingVideo}
      durationInFrames={900}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{
        bridePhotoUrl: "",
        groomPhotoUrl: "",
        bgVideoUrls: [],
        effects: ["static", "glitter", "roses", "timestamp"],
        transition: "star-wipe",
        musicUrl: "",
        musicVolume: 0.75,
        showWatermark: true,
      }}
    />

    {/* ── shortshero ─────────────────────────────────────────────────────── */}
    <Composition
      id="render"
      component={ShortComposition}
      calculateMetadata={({ props }) => {
        const fps = 30;
        const st = Number((props as Record<string, unknown>).startTime ?? 0);
        const et = Number((props as Record<string, unknown>).endTime ?? 4);
        const durationInFrames = Math.max(1, Math.ceil((et - st) * fps));
        return { durationInFrames, fps };
      }}
      durationInFrames={120}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{
        videoUrl: "",
        startTime: 0,
        endTime: 4,
        captions: "[]",
        captionStyle: {},
        showWatermark: false,
      }}
    />

    {/* ── vidgpt ─────────────────────────────────────────────────────────── */}
    <Composition
      id="vidgpt"
      component={VidgptVideo}
      calculateMetadata={({ props }) => {
        const fps = 30;
        const p = props as SizedProps;
        const durationInFrames = Math.max(1, p.durationInFrames ?? 1);
        const width = p.width ?? 1080;
        const height = p.height ?? 1920;
        return { durationInFrames, fps, width, height };
      }}
      durationInFrames={1}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{
        script: [],
        audioFileUrl: "",
        musicUrl: "",
        voiceoverVolume: 1,
        musicVolume: 0.35,
        captions: [],
        imageList: [],
        clipList: [],
        clipDurations: [],
        voiceoverSegments: [],
        extraTracks: [],
        showWatermark: false,
        captionsVisible: true,
        durationInFrames: 1,
        width: 1080,
        height: 1920,
      }}
    />
    <Composition
      id="blog-template"
      component={BlogTemplatePlayer}
      calculateMetadata={({ props }) => {
        const fps = 30;
        const p = props as SizedProps;
        const durationInFrames = Math.max(1, p.durationInFrames ?? 1);
        const width = p.width ?? 1280;
        const height = p.height ?? 720;
        return { durationInFrames, fps, width, height };
      }}
      durationInFrames={1}
      fps={30}
      width={1280}
      height={720}
      defaultProps={{
        script: [],
        audioFileUrl: "",
        musicUrl: "",
        voiceoverVolume: 1,
        musicVolume: 0.35,
        captions: [],
        imageList: [],
        clipDurations: [],
        voiceoverSegments: [],
        showWatermark: false,
        captionsVisible: true,
        themeId: "whiteboard",
        durationInFrames: 1,
        width: 1280,
        height: 720,
      }}
    />
  </>
);

registerRoot(RemotionRoot);
