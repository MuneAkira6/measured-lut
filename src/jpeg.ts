// Find out which RGB space a JPEG's pixel values are encoded in.
//
// Order of evidence:
//   1. An embedded ICC profile (APP2 "ICC_PROFILE"). We do not trust the profile's
//      name; we read its colorants and tone curve and compare them with sRGB and
//      Display P3.
//   2. No profile: the EXIF ColorSpace tag. 1 means sRGB. 0xFFFF ("uncalibrated")
//      with Interoperability index "R03" is the DCF way of saying Adobe RGB.
//   3. Nothing at all: assume sRGB, as browsers and the DCF spec do, and say so.

import { RGB_TO_XYZ, decode, matMul, mul, invert, type Mat3, type RgbSpace, type Vec3 } from "./color";

export interface JpegColor {
  /** null when the file is in a space this tool does not handle. */
  space: RgbSpace | null;
  source: "icc" | "exif" | "assumed";
  /** Human-readable: the profile description or what the EXIF tag said. */
  detail: string;
}

export function jpegColor(buf: ArrayBuffer): JpegColor {
  const { icc, exif } = readSegments(new DataView(buf));
  if (icc) return fromIcc(icc);
  if (exif) {
    const e = readExifColor(exif);
    if (e.colorSpace === 1) return { space: "srgb", source: "exif", detail: "EXIF ColorSpace = sRGB" };
    if (e.interop === "R03") return { space: null, source: "exif", detail: "EXIF says Adobe RGB (R03)" };
    if (e.colorSpace === 0xffff) {
      // iPhone writes this for Display P3 and relies on the ICC profile, which is missing here.
      return { space: null, source: "exif", detail: "EXIF says Uncalibrated and there is no ICC profile" };
    }
  }
  return { space: "srgb", source: "assumed", detail: "No ICC profile or EXIF colour space; assuming sRGB" };
}

// ---------------------------------------------------------------- JPEG segments

function readSegments(v: DataView): { icc?: Uint8Array; exif?: DataView } {
  if (v.getUint16(0) !== 0xffd8) throw new Error("Not a JPEG file");
  const chunks: { seq: number; data: Uint8Array }[] = [];
  let exif: DataView | undefined;
  let p = 2;
  while (p + 4 <= v.byteLength) {
    if (v.getUint8(p) !== 0xff) throw new Error(`Broken JPEG marker at byte ${p}`);
    const marker = v.getUint8(p + 1);
    if (marker === 0xff) {
      p += 1; // fill byte
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image: no more metadata
    const len = v.getUint16(p + 2);
    const start = p + 4;
    const end = p + 2 + len;
    if (marker === 0xe2 && ascii(v, start, 12) === "ICC_PROFILE\0") {
      // A profile larger than 64 KB is split over several APP2 segments.
      chunks.push({ seq: v.getUint8(start + 12), data: new Uint8Array(v.buffer, v.byteOffset + start + 14, end - start - 14) });
    } else if (marker === 0xe1 && ascii(v, start, 6) === "Exif\0\0" && !exif) {
      exif = new DataView(v.buffer, v.byteOffset + start + 6, end - start - 6);
    }
    p = end;
  }
  if (chunks.length === 0) return { exif };
  chunks.sort((a, b) => a.seq - b.seq);
  const icc = new Uint8Array(chunks.reduce((n, c) => n + c.data.length, 0));
  let o = 0;
  for (const c of chunks) {
    icc.set(c.data, o);
    o += c.data.length;
  }
  return { icc, exif };
}

function ascii(v: DataView, at: number, n: number): string {
  let s = "";
  for (let i = 0; i < n && at + i < v.byteLength; i++) s += String.fromCharCode(v.getUint8(at + i));
  return s;
}

// ---------------------------------------------------------------- EXIF (TIFF)

function readExifColor(t: DataView): { colorSpace?: number; interop?: string } {
  const le = ascii(t, 0, 2) === "II";
  const u16 = (o: number) => t.getUint16(o, le);
  const u32 = (o: number) => t.getUint32(o, le);
  // Each IFD: count, then 12-byte entries (tag, type, count, value-or-offset).
  const ifd = (o: number) => {
    const tags = new Map<number, number>();
    if (o <= 0 || o + 2 > t.byteLength) return tags;
    const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      if (e + 12 > t.byteLength) break;
      tags.set(u16(e), e + 8); // byte offset of the value field
    }
    return tags;
  };
  const ifd0 = ifd(u32(4));
  const exifAt = ifd0.get(0x8769);
  if (exifAt === undefined) return {};
  const exifIfd = ifd(u32(exifAt));
  const cs = exifIfd.get(0xa001);
  const interopAt = exifIfd.get(0xa005);
  let interop: string | undefined;
  if (interopAt !== undefined) {
    const idx = ifd(u32(interopAt)).get(0x0001);
    if (idx !== undefined) interop = ascii(t, idx, 3); // 4-byte ASCII fits in the value field
  }
  return { colorSpace: cs === undefined ? undefined : u16(cs), interop };
}

// ---------------------------------------------------------------- ICC

/** Bradford adaptation D65 -> D50; ICC colorant tags are stored relative to D50. */
const BRADFORD: Mat3 = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];
const D50: Vec3 = [0.9642, 1, 0.8249];

function adaptToD50(m: Mat3): Mat3 {
  const d65 = mul(m, [1, 1, 1]);
  const src = mul(BRADFORD, d65);
  const dst = mul(BRADFORD, D50);
  const scale: Mat3 = [
    [dst[0] / src[0], 0, 0],
    [0, dst[1] / src[1], 0],
    [0, 0, dst[2] / src[2]],
  ];
  return matMul(matMul(matMul(invert(BRADFORD), scale), BRADFORD), m);
}

const EXPECTED: Record<RgbSpace, Mat3> = {
  srgb: adaptToD50(RGB_TO_XYZ.srgb),
  "display-p3": adaptToD50(RGB_TO_XYZ["display-p3"]),
};

function fromIcc(icc: Uint8Array): JpegColor {
  const v = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
  const tags = new Map<string, { at: number; size: number }>();
  const n = v.getUint32(128);
  for (let i = 0; i < n; i++) {
    const e = 132 + i * 12;
    tags.set(ascii(v, e, 4), { at: v.getUint32(e + 4), size: v.getUint32(e + 8) });
  }
  const desc = readDesc(v, tags.get("desc")) ?? "unnamed profile";
  const colorSpace = ascii(v, 16, 4);
  if (colorSpace !== "RGB ") return { space: null, source: "icc", detail: `${desc} (not an RGB profile)` };

  const xyz = (sig: string): Vec3 | null => {
    const t = tags.get(sig);
    if (!t || ascii(v, t.at, 4) !== "XYZ ") return null;
    const s15 = (o: number) => v.getInt32(o) / 65536;
    return [s15(t.at + 8), s15(t.at + 12), s15(t.at + 16)];
  };
  const r = xyz("rXYZ");
  const g = xyz("gXYZ");
  const b = xyz("bXYZ");
  if (!r || !g || !b) return { space: null, source: "icc", detail: `${desc} (not a matrix/TRC profile)` };

  const space = (Object.keys(EXPECTED) as RgbSpace[]).find((s) =>
    [r, g, b].every((col, j) => col.every((c, i) => Math.abs(c - EXPECTED[s][i][j]) < 0.005)),
  );
  if (!space) return { space: null, source: "icc", detail: `${desc} (primaries are not sRGB or Display P3)` };

  for (const sig of ["rTRC", "gTRC", "bTRC"]) {
    const curve = readCurve(v, tags.get(sig));
    const ok = curve && [0.02, 0.1, 0.25, 0.5, 0.75, 0.9].every((x) => Math.abs(curve(x) - decode(x)) < 0.002);
    if (!ok) return { space: null, source: "icc", detail: `${desc} (tone curve is not the sRGB curve)` };
  }
  return { space, source: "icc", detail: desc };
}

function readDesc(v: DataView, t?: { at: number; size: number }): string | undefined {
  if (!t) return undefined;
  const type = ascii(v, t.at, 4);
  if (type === "desc") {
    // ICC v2 textDescriptionType: uint32 length, then ASCII including the NUL.
    const len = v.getUint32(t.at + 8);
    return ascii(v, t.at + 12, Math.max(0, len - 1));
  }
  if (type === "mluc") {
    // ICC v4 multiLocalizedUnicodeType: take the first record (UTF-16BE).
    const len = v.getUint32(t.at + 20);
    const off = v.getUint32(t.at + 24);
    let s = "";
    for (let i = 0; i < len; i += 2) s += String.fromCharCode(v.getUint16(t.at + off + i));
    return s;
  }
  return undefined;
}

/** Returns the tag's tone curve as a function, or null for types we do not read. */
function readCurve(v: DataView, t?: { at: number; size: number }): ((x: number) => number) | null {
  if (!t) return null;
  const type = ascii(v, t.at, 4);
  if (type === "curv") {
    const n = v.getUint32(t.at + 8);
    if (n === 0) return (x) => x;
    if (n === 1) {
      const gamma = v.getUint16(t.at + 12) / 256;
      return (x) => x ** gamma;
    }
    const table = Array.from({ length: n }, (_, i) => v.getUint16(t.at + 12 + 2 * i) / 65535);
    return (x) => {
      const f = x * (n - 1);
      const i = Math.min(Math.floor(f), n - 2);
      return table[i] + (table[i + 1] - table[i]) * (f - i);
    };
  }
  if (type === "para") {
    const fn = v.getUint16(t.at + 8);
    const count = [1, 3, 4, 5, 7][fn];
    if (count === undefined) return null;
    const [g, a = 1, b = 0, c = 0, d = 0, e = 0, f = 0] = Array.from(
      { length: count },
      (_, i) => v.getInt32(t.at + 12 + 4 * i) / 65536,
    );
    switch (fn) {
      case 0:
        return (x) => x ** g;
      case 1:
        return (x) => (x >= -b / a ? (a * x + b) ** g : 0);
      case 2:
        return (x) => (x >= -b / a ? (a * x + b) ** g + c : c);
      case 3:
        return (x) => (x >= d ? (a * x + b) ** g : c * x);
      default:
        return (x) => (x >= d ? (a * x + b) ** g + e : c * x + f);
    }
  }
  return null;
}
