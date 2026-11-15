import { describe, expect, it } from "vitest";
import { DEFAULT_SAMPLE_OPTIONS, Label, samplePairs } from "../src/samples";

// 128 x 128: left half mid grey, right half a darker grey, so there is one vertical
// edge. Top-left 16 x 16 is pure white (clipped). The bottom 8 rows are outside the warp.
function scene() {
  const w = 128;
  const h = 128;
  const a = new Float32Array(w * h * 3);
  const b = new Float32Array(w * h * 3);
  const valid = new Uint8Array(w * h).fill(1);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = x < 64 ? 0.5 : 0.3;
      const white = x < 16 && y < 16;
      for (let c = 0; c < 3; c++) {
        a[i * 3 + c] = white ? 1 : v;
        b[i * 3 + c] = white ? 1 : v * 0.9 + (c === 0 ? 0.02 : 0); // B is a bit darker and redder
      }
      if (y >= h - 8) valid[i] = 0;
    }
  return { w, h, a, b, valid };
}

describe("samplePairs", () => {
  const { w, h, a, b, valid } = scene();
  const res = samplePairs(a, valid, b, w, h, { ...DEFAULT_SAMPLE_OPTIONS, sigma: 1 });

  it("drops clipped pixels, edge pixels and pixels outside the warp", () => {
    expect(res.labels[5 * w + 5]).toBe(Label.Clipped);
    expect(res.labels[40 * w + 64]).toBe(Label.Edge);
    expect(res.labels[(h - 1) * w + 40]).toBe(Label.Outside);
    const total = Object.values(res.counts).reduce((s, v) => s + v, 0);
    expect(total).toBe(w * h);
  });

  it("pairs keep A and B values from the same pixel", () => {
    for (let k = 0; k < res.fit.src.length / 3; k++) {
      const av = res.fit.src[k * 3 + 1];
      const bv = res.fit.dst[k * 3 + 1];
      expect(Math.abs(bv - av * 0.9)).toBeLessThan(1e-4);
    }
  });

  it("holds out whole blocks, roughly the requested fraction, and the same ones every run", () => {
    const frac = res.counts.check / (res.counts.check + res.counts.fit);
    expect(frac).toBeGreaterThan(0.02);
    expect(frac).toBeLessThan(0.5);
    // Every pixel in a 32 px block shares the label (where it is kept at all).
    for (let by = 0; by < 3; by++)
      for (let bx = 0; bx < 4; bx++) {
        const kinds = new Set<number>();
        for (let y = by * 32; y < by * 32 + 32; y++)
          for (let x = bx * 32; x < bx * 32 + 32; x++) {
            const l = res.labels[y * w + x];
            if (l === Label.Fit || l === Label.Check) kinds.add(l);
          }
        expect(kinds.size).toBeLessThanOrEqual(1);
      }
    const again = samplePairs(a, valid, b, w, h, { ...DEFAULT_SAMPLE_OPTIONS, sigma: 1 });
    expect(again.labels).toEqual(res.labels);
  });
});
