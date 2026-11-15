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
  if (!color.space) throw new Error(`${file.name}: ${color.detail}. Only sRGB and Display P3 JPEGs are supported.`);
  const bitmap = await createImageBitmap(new Blob([buf], { type: "image/jpeg" }), {
    colorSpaceConversion: "none",
    imageOrientation: "from-image",
  });
  return { name: file.name, color, bitmap };
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
