// Read a JPEG into Display P3 encoded floats.
//
// The browser is asked NOT to colour-manage (colorSpaceConversion: "none"), so we
// get the file's own code values and do the one conversion we need (sRGB -> P3)
// ourselves, with the same matrices the tests check against colour-science.

import { SRGB_TO_P3, decode, encode } from "./color";
import { jpegColor, type JpegColor } from "./jpeg";

export interface Photo {
  name: string;
  color: JpegColor;
  /** Full-size decoded image, raw code values, EXIF orientation applied. */
  bitmap: ImageBitmap;
}

export async function readPhoto(file: File): Promise<Photo> {
  const buf = await file.arrayBuffer();
  const color = jpegColor(buf);
  const blob = new Blob([buf], { type: "image/jpeg" });
  if (color.space) {
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", imageOrientation: "from-image" });
    return { name: file.name, color, bitmap };
  }
  if (color.browser) return { name: file.name, color: { ...color, space: "display-p3" }, bitmap: await viaBrowser(blob) };
  throw new Error(
    `${file.name}: ${color.detail}. Export it again as sRGB or Display P3 (in Photos for Mac: File → Export, Color Profile).`,
  );
}

/**
 * For ICC profiles we do not handle ourselves: let the browser convert the image
 * into a Display P3 canvas, then keep those P3 code values as an untagged bitmap,
 * so the rest of the tool sees the same kind of data as on the exact path.
 */
async function viaBrowser(blob: Blob): Promise<ImageBitmap> {
  const managed = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const canvas = new OffscreenCanvas(managed.width, managed.height);
  const ctx = canvas.getContext("2d", { colorSpace: "display-p3" })!;
  ctx.drawImage(managed, 0, 0);
  const p3 = ctx.getImageData(0, 0, managed.width, managed.height, { colorSpace: "display-p3" });
  managed.close();
  // Same bytes, labelled sRGB, so that drawing it later does not convert it again.
  const raw = new ImageData(p3.data, p3.width, p3.height, { colorSpace: "srgb" });
  return createImageBitmap(raw, { colorSpaceConversion: "none" });
}

export interface Pixels {
  /** Interleaved RGB, Display P3 encoded, 0..1. */
  rgb: Float32Array;
  w: number;
  h: number;
  /** Working size / full size. */
  scale: number;
}

/** Downscale so the long side is at most `maxSide`, and convert to Display P3. */
export function pixels(photo: Photo, maxSide: number): Pixels {
  const { width, height } = photo.bitmap;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(photo.bitmap, 0, 0, w, h);
  const raw = ctx.getImageData(0, 0, w, h, { colorSpace: "srgb" }).data;
  const rgb = new Float32Array(w * h * 3);
  const toP3 = photo.color.space === "srgb";
  // 256-entry tables: decoding every byte with pow() is the slow part otherwise.
  const lin = Float32Array.from({ length: 256 }, (_, i) => decode(i / 255));
  const m = SRGB_TO_P3;
  for (let i = 0, o = 0; i < raw.length; i += 4, o += 3) {
    if (toP3) {
      const r = lin[raw[i]];
      const g = lin[raw[i + 1]];
      const b = lin[raw[i + 2]];
      rgb[o] = encode(m[0][0] * r + m[0][1] * g + m[0][2] * b);
      rgb[o + 1] = encode(m[1][0] * r + m[1][1] * g + m[1][2] * b);
      rgb[o + 2] = encode(m[2][0] * r + m[2][1] * g + m[2][2] * b);
    } else {
      rgb[o] = raw[i] / 255;
      rgb[o + 1] = raw[i + 1] / 255;
      rgb[o + 2] = raw[i + 2] / 255;
    }
  }
  return { rgb, w, h, scale };
}
