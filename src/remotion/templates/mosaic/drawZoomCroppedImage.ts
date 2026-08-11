/**
 * Canvas drawing matching ZoomCropImg — the mosaic tile effect samples its
 * colours from this, so it has to frame the image the same way the layout
 * displays it or the tiles resolve into a picture that is not on screen.
 *
 *   zoom == 1 (default) →  object-fit: contain, centered (the whole image)
 *   zoom  >  1          →  object-fit: cover, scale from focus point (crops edges)
 *   zoom  <  1          →  object-fit: contain, scale from center
 */
export function parseObjectPositionPercent(s?: string): { px: number; py: number } {
  const p = (s ?? "50% 50%").trim().split(/\s+/);
  const x = parseFloat(String(p[0] ?? "50%").replace("%", "")) || 50;
  const y = parseFloat(String(p[1] ?? "50%").replace("%", "")) || 50;
  return {
    px: Math.max(0, Math.min(100, x)),
    py: Math.max(0, Math.min(100, y)),
  };
}

export function drawZoomCroppedImage(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  destW: number,
  destH: number,
  imageObjectPosition?: string,
  imageZoom?: number,
): void {
  const nw =
    (img as HTMLImageElement).naturalWidth ||
    (img as HTMLImageElement).width ||
    (img as HTMLCanvasElement).width;
  const nh =
    (img as HTMLImageElement).naturalHeight ||
    (img as HTMLImageElement).height ||
    (img as HTMLCanvasElement).height;
  if (!nw || !nh) {
    ctx.drawImage(img, 0, 0, destW, destH);
    return;
  }

  const z = Math.max(0.1, imageZoom ?? 1);
  // Only an explicit zoom-IN crops; at the default zoom the whole image is kept.
  const isZoomedIn = z > 1;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, destW, destH);
  ctx.clip();

  if (!isZoomedIn) {
    // object-fit: contain — scale to fit, center the image, then apply user zoom from center
    const scale = Math.min(destW / nw, destH / nh);
    const w = nw * scale * z;
    const h = nh * scale * z;
    const dx = (destW - w) / 2;
    const dy = (destH - h) / 2;
    ctx.drawImage(img, 0, 0, nw, nh, dx, dy, w, h);
  } else {
    // object-fit: cover — scale to fill, pan to focus point, then apply user zoom
    const { px, py } = parseObjectPositionPercent(imageObjectPosition);
    const fx = (destW * px) / 100;
    const fy = (destH * py) / 100;
    ctx.translate(fx, fy);
    ctx.scale(z, z);
    ctx.translate(-fx, -fy);
    const scale = Math.max(destW / nw, destH / nh);
    const w = nw * scale;
    const h = nh * scale;
    const dx = (destW - w) * (px / 100);
    const dy = (destH - h) * (py / 100);
    ctx.drawImage(img, 0, 0, nw, nh, dx, dy, w, h);
  }

  ctx.restore();
}
