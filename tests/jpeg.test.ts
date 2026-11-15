import { describe, expect, it } from "vitest";
import { jpegColor } from "../src/jpeg";

// Test files are assembled byte by byte here, so the repo carries no third-party
// ICC profiles. The parser stops at the first scan, so no image data is needed.

type Curve = { para: number[] } | { table: number[] };

function iccProfile(opts: { desc: string; colorants: number[][]; curve: Curve; v4?: boolean }): Uint8Array {
  const tags: [string, number[]][] = [];
  const bytes = (...xs: number[]) => xs;
  const u32 = (n: number) => bytes((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  const u16 = (n: number) => bytes((n >>> 8) & 255, n & 255);
  const s15 = (x: number) => u32(Math.round(x * 65536) >>> 0);
  const str = (s: string) => [...s].map((c) => c.charCodeAt(0));

  if (opts.v4) {
    const utf16 = [...opts.desc].flatMap((c) => u16(c.charCodeAt(0)));
    tags.push(["desc", [...str("mluc"), ...u32(0), ...u32(1), ...u32(12), ...str("enUS"), ...u32(utf16.length), ...u32(28), ...utf16]]);
  } else {
    tags.push(["desc", [...str("desc"), ...u32(0), ...u32(opts.desc.length + 1), ...str(opts.desc), 0]]);
  }
  ["rXYZ", "gXYZ", "bXYZ"].forEach((sig, j) => {
    tags.push([sig, [...str("XYZ "), ...u32(0), ...opts.colorants[j].flatMap(s15)]]);
  });
  const trc =
    "para" in opts.curve
      ? [...str("para"), ...u32(0), ...u16(3), ...u16(0), ...opts.curve.para.flatMap(s15)]
      : [...str("curv"), ...u32(0), ...u32(opts.curve.table.length), ...opts.curve.table.flatMap((x) => u16(Math.round(x * 65535)))];
  ["rTRC", "gTRC", "bTRC"].forEach((sig) => tags.push([sig, trc]));

  const header = new Array(128).fill(0);
  header.splice(16, 4, ...str("RGB "));
  const table = u32(tags.length);
  const data: number[] = [];
  let at = 128 + 4 + tags.length * 12;
  for (const [sig, body] of tags) {
    while (body.length % 4) body.push(0);
    table.push(...str(sig), ...u32(at), ...u32(body.length));
    data.push(...body);
    at += body.length;
  }
  return new Uint8Array([...header, ...table, ...data]);
}

function jpeg(segments: { marker: number; body: number[] }[]): ArrayBuffer {
  const out = [0xff, 0xd8];
  for (const s of segments) out.push(0xff, s.marker, ((s.body.length + 2) >> 8) & 255, (s.body.length + 2) & 255, ...s.body);
  out.push(0xff, 0xd9);
  return new Uint8Array(out).buffer;
}

function app2Chunks(icc: Uint8Array, size: number) {
  const n = Math.ceil(icc.length / size);
  return Array.from({ length: n }, (_, i) => ({
    marker: 0xe2,
    body: [..."ICC_PROFILE\0"].map((c) => c.charCodeAt(0)).concat(i + 1, n, ...icc.slice(i * size, (i + 1) * size)),
  }));
}

// D50-adapted colorants as they appear in real profiles (rounded the way profile
// makers round them, so the parser's tolerance gets exercised).
const SRGB = [
  [0.4361, 0.2225, 0.0139],
  [0.3851, 0.7169, 0.0971],
  [0.1431, 0.0606, 0.7141],
];
const P3 = [
  [0.5151, 0.2412, -0.0011],
  [0.292, 0.6922, 0.0419],
  [0.1571, 0.0666, 0.7841],
];
const ADOBE = [
  [0.6097, 0.3111, 0.0195],
  [0.2053, 0.6257, 0.0609],
  [0.1492, 0.0632, 0.7446],
];
const SRGB_PARA = { para: [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045] };

describe("jpegColor", () => {
  it("reads a Display P3 profile (v4, parametric curve)", () => {
    const icc = iccProfile({ desc: "Display P3", colorants: P3, curve: SRGB_PARA, v4: true });
    expect(jpegColor(jpeg(app2Chunks(icc, 65519)))).toEqual({ space: "display-p3", source: "icc", detail: "Display P3" });
  });

  it("reads an sRGB profile (v2, 1024-entry table) split over three APP2 segments", () => {
    const table = Array.from({ length: 1024 }, (_, i) => {
      const x = i / 1023;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    const icc = iccProfile({ desc: "sRGB IEC61966-2.1", colorants: SRGB, curve: { table } });
    const segs = app2Chunks(icc, 1000);
    expect(segs.length).toBeGreaterThanOrEqual(3);
    expect(jpegColor(jpeg([segs[2], segs[0], segs[1], ...segs.slice(3)]))).toMatchObject({ space: "srgb", source: "icc" });
  });

  it("trusts colorants, not the profile name", () => {
    const icc = iccProfile({ desc: "sRGB", colorants: P3, curve: SRGB_PARA });
    expect(jpegColor(jpeg(app2Chunks(icc, 65519))).space).toBe("display-p3");
  });

  it("hands other RGB profiles (Adobe RGB, gamma 2.2) to the browser instead of guessing", () => {
    const adobe = iccProfile({ desc: "Adobe RGB (1998)", colorants: ADOBE, curve: { table: [] } });
    expect(jpegColor(jpeg(app2Chunks(adobe, 65519)))).toMatchObject({ space: null, browser: true });
    const g22 = iccProfile({ desc: "P3 gamma 2.2", colorants: P3, curve: { para: [2.2] } });
    expect(jpegColor(jpeg(app2Chunks(g22, 65519)))).toMatchObject({ space: null, browser: true, detail: "P3 gamma 2.2" });
  });

  it("falls back to EXIF ColorSpace, and recognises the DCF Adobe RGB marker", () => {
    // Little-endian TIFF: IFD0 -> Exif IFD (ColorSpace, Interop pointer) -> Interop IFD.
    const tiff = (colorSpace: number, interop?: string) => {
      const b: number[] = [0x49, 0x49, 42, 0, 8, 0, 0, 0];
      const entry = (tag: number, type: number, count: number, value: number[]) => [tag & 255, tag >> 8, type, 0, count, 0, 0, 0, ...value];
      const le32 = (n: number) => [n & 255, (n >> 8) & 255, 0, 0];
      b.push(1, 0, ...entry(0x8769, 4, 1, le32(26)), 0, 0, 0, 0); // IFD0 at 8, Exif IFD at 26
      const exifEntries = interop ? 2 : 1;
      const interopAt = 26 + 2 + exifEntries * 12 + 4;
      b.push(exifEntries, 0, ...entry(0xa001, 3, 1, [colorSpace & 255, colorSpace >> 8, 0, 0]));
      if (interop) b.push(...entry(0xa005, 4, 1, le32(interopAt)));
      b.push(0, 0, 0, 0);
      if (interop) b.push(1, 0, ...entry(0x0001, 2, 4, [...interop].map((c) => c.charCodeAt(0)).concat(0)), 0, 0, 0, 0);
      return { marker: 0xe1, body: [..."Exif\0\0"].map((c) => c.charCodeAt(0)).concat(b) };
    };
    expect(jpegColor(jpeg([tiff(1)]))).toMatchObject({ space: "srgb", source: "exif" });
    expect(jpegColor(jpeg([tiff(0xffff, "R03")]))).toMatchObject({ space: null, detail: "EXIF says Adobe RGB (R03)" });
  });

  it("assumes sRGB when there is no colour information", () => {
    expect(jpegColor(jpeg([]))).toMatchObject({ space: "srgb", source: "assumed" });
  });
});
