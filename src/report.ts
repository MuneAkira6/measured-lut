// How far apart the two cameras are, before and after the LUT, on pixels the
// fitter never saw.

import { deltaE2000, rgbToXyz, xyzToLab, type Vec3 } from "./color";
import { lookup, type Lut } from "./lut";
import type { Pairs } from "./samples";

export interface ErrorStats {
  n: number;
  median: number;
  p95: number;
  mean: number;
}

/** CIEDE2000 between A (optionally through `lut`) and B, both Display P3 encoded. */
export function deltaEStats(pairs: Pairs, lut?: Lut): ErrorStats {
  const n = pairs.src.length / 3;
  const de = new Float64Array(n);
  const a: Vec3 = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    const o = k * 3;
    if (lut) lookup(lut, pairs.src[o], pairs.src[o + 1], pairs.src[o + 2], a);
    else a.splice(0, 3, pairs.src[o], pairs.src[o + 1], pairs.src[o + 2]);
    const b: Vec3 = [pairs.dst[o], pairs.dst[o + 1], pairs.dst[o + 2]];
    de[k] = deltaE2000(xyzToLab(rgbToXyz(a, "display-p3")), xyzToLab(rgbToXyz(b, "display-p3")));
  }
  de.sort();
  const q = (p: number) => (n ? de[Math.min(n - 1, Math.floor(p * n))] : NaN);
  return { n, median: q(0.5), p95: q(0.95), mean: n ? de.reduce((s, v) => s + v, 0) / n : NaN };
}
