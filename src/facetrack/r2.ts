/**
 * The two R2 functions the vendored face-tracking pipeline calls.
 *
 * Deliberately hand-written rather than synced from the app. The app's
 * lib/r2.ts is ~1000 lines of bucket routing, presigning, tool assets and
 * export-bucket fallbacks; facetrack.ts touches exactly two of its exports, and
 * vendoring the rest would drag in configuration this box does not have.
 *
 * Credentials come from the same R2_* variables the render server already uses
 * for uploading finished renders, so a working render server needs no new
 * secrets to face-track.
 */
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream } from "fs";

/**
 * Face-tracked clips do NOT go in the render bucket.
 *
 * This box writes finished renders to `R2_BUCKET` (`render`, published at
 * render.shortshero.com). Face-tracked clips have always lived in the APP's
 * upload bucket (`shortshero`, published at cdn.shortshero.com), because that
 * is where the app's own crop path put them and where everything downstream
 * expects them: the editor preview loads that URL, and `r2LocationFromUrl` in
 * the app resolves it back to a bucket in order to presign it for a render.
 *
 * Getting this wrong is not a cosmetic mismatch. A clip written to `render`
 * would come back as a render.shortshero.com URL, which the app maps to its
 * EXPORT base — and `CLOUDFLARE_R2_EXPORT_BUCKET_NAME` is unset there, so that
 * base falls back to the upload bucket. The app would then presign
 * `shortshero/facetracked/<id>.mp4`, a key that only exists in `render`, and R2
 * answers NoSuchKey. The render fails on a file that uploaded perfectly.
 *
 * So these are their own variables, defaulting to the render bucket only so a
 * deployment where one bucket fronts everything still works.
 */
const bucket = process.env.FACETRACK_R2_BUCKET || process.env.R2_BUCKET || "";
const publicUrl = (process.env.FACETRACK_R2_PUBLIC_URL || process.env.R2_PUBLIC_URL || "")
  .replace(/\/$/, "");

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
  },
});

/**
 * Where the pipeline should fetch a source video from.
 *
 * The app hands this server fully-formed URLs — a presigned R2 URL, or a public
 * CDN one — because the app is the side that knows which bucket a key lives in.
 * So there is nothing to rewrite here, and rewriting would be actively wrong:
 * a presigned URL that got its query string stripped 403s.
 */
export async function toDownloadableUrl(url: string): Promise<string> {
  return url;
}

/** Streams a finished crop to R2 and returns its public URL. */
export async function uploadFileToR2(
  filePath: string,
  key: string,
  contentType = "video/mp4",
): Promise<string> {
  const upload = new Upload({
    client: r2,
    params: {
      Bucket: bucket,
      Key: key,
      Body: createReadStream(filePath),
      ContentType: contentType,
      // Same reasoning as the render upload in vps-server.ts: a crop is written
      // once to a key derived per short and never rewritten, so it can be
      // cached forever. Without this R2 sends no Cache-Control at all.
      CacheControl: "public, max-age=31536000, immutable",
    },
    partSize: 8 * 1024 * 1024,
    queueSize: 4,
  });
  await upload.done();
  return publicUrl ? `${publicUrl}/${key}` : key;
}
