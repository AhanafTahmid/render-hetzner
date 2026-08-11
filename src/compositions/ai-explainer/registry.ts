/**
 * AI Explainer — turning compiled scene source into components.
 *
 * The scenes a project renders do not exist when anything is built: they are
 * TSX the model wrote, transformed to CommonJS on the server
 * (`lib/ai-explainer/preview.ts`) and evaluated here against the React and
 * Remotion instances of whoever is running — the dashboard player, or the
 * headless browser on the render server.
 *
 * That shared use is why this lives in `remotion/` rather than beside the
 * dashboard components it started in. Both callers must resolve a scene's
 * imports to the *same* module objects they are themselves using, or hooks fire
 * against a second React and `<Audio>` never joins the timeline. One
 * implementation is also what keeps a preview and its mp4 honest: the dashboard
 * evaluates exactly the bundle the render will.
 *
 * See `lib/ai-explainer/preview.ts` for the other side of the wire.
 */

import ReactDefault from "react";
import * as Remotion from "remotion";

import { AE_ICONS } from "./aeIcons";
import type { AeSceneComponent } from "./SceneStoryboardPlayer";

// ─── Wire format (mirrors lib/ai-explainer/preview.ts) ────────────────────────

export interface AePreviewScene {
  scene_key: string;
  component_name: string;
  title: string;
  js: string;
  error?: string;
}

export interface AePreviewBundle {
  styles: string;
  reference: string;
  scenes: AePreviewScene[];
}

// ─── Module shims ─────────────────────────────────────────────────────────────

/**
 * `__esModule` is what sucrase's interop helper checks before deciding whether
 * to wrap a required module in `{ default: … }`. Setting it (and carrying an
 * explicit `default`) makes both `import React from "react"` and
 * `import { useCurrentFrame } from "remotion"` resolve to the same instances
 * the host is running.
 */
const REACT_MODULE = { ...ReactDefault, default: ReactDefault, __esModule: true };
const REMOTION_MODULE = { ...Remotion, __esModule: true };

/**
 * Only the icons on the curated list, never `import * as Lucide`. A namespace
 * import reached through this shim cannot be tree-shaken, so it would put all
 * ~1500 lucide icons — 14 MB of ESM — into the bundle of every page that renders
 * a AE preview. See `lib/ai-explainer/icons.ts`.
 */
const LUCIDE_MODULE = { ...AE_ICONS, __esModule: true };

type Module = Record<string, unknown>;

/** Runs one CommonJS string and returns its exports. */
function evaluateModule(js: string, require: (id: string) => Module): Module {
  const module = { exports: {} as Module };
  // eslint-disable-next-line no-new-func
  const factory = new Function("require", "module", "exports", js);
  factory(require, module, module.exports);
  return module.exports;
}

export interface AeRegistry {
  /** Indexed by `scene_key`, which is what the storyboard's `type` resolves to. */
  scenes: Record<string, AeSceneComponent>;
  failures: { title: string; error: string }[];
}

/**
 * Compiles a preview bundle into a scene registry.
 *
 * Scene files sit in `scenes/` and Reference.tsx in `scenes/components/`, so the
 * same module is reached by two different relative ids depending on who is
 * asking — both normalise to the same entry here.
 *
 * A scene that throws while evaluating is dropped rather than taking the page
 * down with it; the composition draws its own "Scene Not Found" card in that
 * slot. Losing the styles module is fatal for all of them, since it is the
 * layout contract every scene imports.
 */
export function buildAeRegistry(bundle: AePreviewBundle): AeRegistry {
  const failures: AeRegistry["failures"] = [];

  const resolve = (id: string, styles: Module, reference: Module): Module => {
    const base = id.replace(/^\.{1,2}\//, "").replace(/\.tsx?$/, "");
    if (id === "react") return REACT_MODULE as Module;
    if (id === "remotion") return REMOTION_MODULE as Module;
    if (id === "lucide-react") return LUCIDE_MODULE as Module;
    if (base === "styles") return styles;
    if (base === "components/Reference" || base === "Reference") return reference;
    throw new Error(`Scene imported "${id}", which the preview cannot resolve`);
  };

  let styles: Module = {};
  let reference: Module = {};
  try {
    styles = evaluateModule(bundle.styles, (id) => resolve(id, styles, reference));
    reference = evaluateModule(bundle.reference, (id) => resolve(id, styles, reference));
  } catch (err) {
    return { scenes: {}, failures: [{ title: "styles / Reference", error: String(err) }] };
  }

  const scenes: Record<string, AeSceneComponent> = {};
  for (const scene of bundle.scenes) {
    if (scene.error) {
      failures.push({ title: scene.title, error: scene.error });
      continue;
    }
    try {
      const exports = evaluateModule(scene.js, (id) => resolve(id, styles, reference));
      const component = (exports[scene.component_name] ?? exports.default) as
        | AeSceneComponent
        | undefined;
      if (typeof component !== "function") {
        throw new Error(`No export named ${scene.component_name}`);
      }
      scenes[scene.scene_key] = component;
    } catch (err) {
      failures.push({ title: scene.title, error: (err as Error).message || String(err) });
    }
  }

  return { scenes, failures };
}
