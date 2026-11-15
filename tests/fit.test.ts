import { describe, expect, it } from "vitest";
import { decode, encode } from "../src/color";
import { evaluate, fitLut, thinPlateEnergy } from "../src/fit";
import { mulberry32 } from "../src/samples";

const N = 9;
function lattice(f: (r: number, g: number, b: number) => number) {
  const v = new Float64Array(N ** 3);
  for (let b = 0, j = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++, j++) v[j] = f(r / (N - 1), g / (N - 1), b / (N - 1));
  return v;
}

describe("thin-plate energy", () => {
  it("is zero for affine functions, including at the boundary", () => {
    expect(thinPlateEnergy(N, lattice((r, g, b) => 0.3 + 0.5 * r - 0.2 * g + 0.9 * b))).toBeLessThan(1e-20);
  });
  it("penalises twist (r·g), which axial second differences alone would miss", () => {
    expect(thinPlateEnergy(N, lattice((r, g) => r * g))).toBeGreaterThan(1e-3);
  });
});

// A "camera B" that differs from A by a linear-light matrix (warmer, a little more
// saturated) plus a gentle tone curve, as a stand-in for real rendering differences.
const M = [
  [1.08, -0.05, -0.03],
  [-0.02, 1.04, -0.02],
  [-0.01, -0.06, 0.95],
];
function cameraB(rgb: number[]): number[] {
  const l = rgb.map(decode);
  return M.map((row) => {
    const v = Math.min(1, Math.max(0, row[0] * l[0] + row[1] * l[1] + row[2] * l[2]));
    return encode(v) ** 1.05;
  });
}

/** Colours of a typical scene: mostly low to medium saturation, no pure primaries. */
function scene(n: number, seed: number) {
  const rand = mulberry32(seed);
  const src = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const grey = 0.15 + 0.75 * rand();
    for (let c = 0; c < 3; c++) src[i * 3 + c] = Math.min(1, Math.max(0, grey + 0.25 * (rand() - 0.5)));
  }
  return src;
}

// These solve full 33^3 systems; shared CI runners need more than the 5 s default.
describe("fitLut", { timeout: 30_000 }, () => {
  it("returns the identity when both cameras agree", () => {
    const src = scene(5000, 1);
    const { lut } = fitLut({ src, dst: src }, { size: 17, prior: "identity" });
    const out = evaluate(lut, src);
    for (let i = 0; i < src.length; i++) expect(Math.abs(out[i] - src[i])).toBeLessThan(1e-3);
  });

  it("recovers a known transform from noisy pairs, on colours it did not see", () => {
    const rand = mulberry32(7);
    const src = scene(20000, 2);
    const dst = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      const b = cameraB([src[i], src[i + 1], src[i + 2]]);
      for (let c = 0; c < 3; c++) dst[i + c] = b[c] + (rand() - 0.5) * (2 / 255); // ±1 code value of noise
    }
    const test = scene(2000, 3);
    for (const prior of ["identity", "matrix"] as const) {
      const { lut, iterations } = fitLut({ src, dst }, { size: 33, prior });
      const out = evaluate(lut, test);
      let worst = 0;
      let sq = 0;
      for (let i = 0; i < test.length; i += 3) {
        const b = cameraB([test[i], test[i + 1], test[i + 2]]);
        for (let c = 0; c < 3; c++) {
          const e = Math.abs(out[i + c] - b[c]);
          worst = Math.max(worst, e);
          sq += e * e;
        }
      }
      const rms = Math.sqrt(sq / test.length) * 255;
      // In 8-bit code values. The noise alone is ±1 (rms 0.58 per pair).
      expect(rms, `${prior}: rms error`).toBeLessThan(0.5);
      expect(worst * 255, `${prior}: worst error`).toBeLessThan(3);
      expect(iterations).toBeLessThan(3000);
    }
  });

  it("keeps empty corners of the cube sane", () => {
    const src = scene(20000, 4);
    const dst = src.map((v) => v * 0.95);
    const { lut } = fitLut({ src, dst }, { size: 33, prior: "identity" });
    // Pure saturated primaries are far from every sample.
    const out = evaluate(lut, Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]));
    const expected = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    out.forEach((v, i) => expect(Math.abs(v - expected[i])).toBeLessThan(0.15));
  });
});
