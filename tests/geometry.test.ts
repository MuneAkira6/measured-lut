import { describe, expect, it } from "vitest";
import { apply, homography, inverse, warp, type Point } from "../src/geometry";

// A perspective that looks like a phone shot of a camera's frame: scale, rotation,
// shift and a bit of keystone.
const TRUE_H = [0.62, 0.05, 310, -0.04, 0.6, 180, 2e-5, -1e-5, 1];

describe("homography", () => {
  it("recovers a known perspective from 4 pairs on a 6000 x 4000 image", () => {
    const src: Point[] = [
      [512, 400],
      [5600, 350],
      [5800, 3700],
      [300, 3500],
    ];
    const H = homography(src, src.map((p) => apply(TRUE_H, p)));
    H.forEach((v, i) => expect(v).toBeCloseTo(TRUE_H[i], 8));
    // And it maps a point that was not used in the fit.
    const q: Point = [3000, 2000];
    const [u, v] = apply(H, q);
    const [eu, ev] = apply(TRUE_H, q);
    expect(Math.hypot(u - eu, v - ev)).toBeLessThan(1e-6);
  });

  it("inverse undoes the mapping", () => {
    const p: Point = [1234, 987];
    const back = apply(inverse(TRUE_H), apply(TRUE_H, p));
    expect(back[0]).toBeCloseTo(p[0], 8);
    expect(back[1]).toBeCloseTo(p[1], 8);
  });

  it("refuses collinear points", () => {
    const src: Point[] = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 0],
    ];
    expect(() => homography(src, src)).toThrow(/degenerate/);
  });
});

describe("warp", () => {
  it("shifts an image by whole pixels and marks the uncovered border invalid", () => {
    const sw = 6;
    const sh = 4;
    const src = new Float32Array(sw * sh * 3).map((_, i) => i);
    const shift = [1, 0, 2, 0, 1, 1, 0, 0, 1]; // dst = src + (2, 1)
    const { rgb, valid } = warp(src, sw, sh, shift, sw, sh);
    // dst (3, 2) comes from src (1, 1).
    expect(valid[2 * sw + 3]).toBe(1);
    expect(rgb[(2 * sw + 3) * 3 + 1]).toBeCloseTo(src[(1 * sw + 1) * 3 + 1], 5);
    // dst (0, 0) would come from src (-2, -1): outside.
    expect(valid[0]).toBe(0);
  });
});
