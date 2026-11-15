// Turn two registered images into pairs of colours for fitting and for checking.
//
// Both images are in the same frame (A was warped onto B) and hold Display P3
// encoded values. The rules follow the Python study this tool grew out of:
// blur both a little so small misregistration and noise average out, then drop
// pixels near edges (where a one-pixel shift changes the colour a lot), pixels
// that are clipped or nearly black, and pixels outside the warped area.

import { decode } from "./color";

export interface SampleOptions {
  /** Gaussian blur sigma in pixels at the working size. */
  sigma: number;
  /** Keep pixels whose edge strength is below this percentile (0-100). */
  edgePercentile: number;
  /** Drop a pixel if any channel of either image is at or above this (encoded). */
  highlight: number;
  /** Drop a pixel if the luminance of either image is below this (relative, linear). */
  shadow: number;
  /** Fraction of 32 px blocks held out from fitting, used only for the error report. */
  holdout: number;
  /** Upper bound on pairs kept, to bound fitting time. */
  maxPairs: number;
  seed: number;
}

export const DEFAULT_SAMPLE_OPTIONS: SampleOptions = {
  sigma: 2,
  edgePercentile: 70,
  highlight: 0.98,
  shadow: 0.01,
  holdout: 0.2,
  maxPairs: 60000,
  seed: 1,
};

/** Per-pixel label, for drawing which pixels were used. */
export const Label = { Outside: 0, Clipped: 1, Edge: 2, Fit: 3, Check: 4 } as const;

export interface Pairs {
  /** Interleaved RGB, A (source camera). */
  src: Float32Array;
  /** Interleaved RGB, B (target camera). */
  dst: Float32Array;
}

export interface SampleResult {
  fit: Pairs;
  check: Pairs;
  labels: Uint8Array;
  counts: Record<"outside" | "clipped" | "edge" | "fit" | "check", number>;
}

const BLOCK = 32;

export function samplePairs(
  a: Float32Array,
  validA: Uint8Array,
  b: Float32Array,
  w: number,
  h: number,
  opts: SampleOptions = DEFAULT_SAMPLE_OPTIONS,
): SampleResult {
  const n = w * h;
  const ab = blur(a, w, h, opts.sigma);
  const bb = blur(b, w, h, opts.sigma);
  // The blur pulls in pixels from up to 3 sigma away; those near the warp border
  // may have mixed in "outside" zeros.
  const valid = erode(validA, w, h, Math.ceil(3 * opts.sigma) + 1);

  const lumA = luminance(ab);
  const lumB = luminance(bb);
  const edge = gradient(lumB, w, h);
  const edges: number[] = [];
  for (let i = 0; i < n; i++) if (valid[i]) edges.push(edge[i]);
  edges.sort((x, y) => x - y);
  const edgeLimit = edges.length ? edges[Math.min(edges.length - 1, Math.floor((edges.length * opts.edgePercentile) / 100))] : 0;

  const rand = mulberry32(opts.seed);
  const bw = Math.ceil(w / BLOCK);
  const bh = Math.ceil(h / BLOCK);
  const heldOut = Uint8Array.from({ length: bw * bh }, () => (rand() < opts.holdout ? 1 : 0));

  const labels = new Uint8Array(n);
  const counts = { outside: 0, clipped: 0, edge: 0, fit: 0, check: 0 };
  const fitIdx: number[] = [];
  const checkIdx: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!valid[i]) {
        counts.outside++;
        continue;
      }
      const o = i * 3;
      const maxA = Math.max(ab[o], ab[o + 1], ab[o + 2]);
      const maxB = Math.max(bb[o], bb[o + 1], bb[o + 2]);
      if (maxA >= opts.highlight || maxB >= opts.highlight || lumA[i] < opts.shadow || lumB[i] < opts.shadow) {
        labels[i] = Label.Clipped;
        counts.clipped++;
      } else if (edge[i] > edgeLimit) {
        labels[i] = Label.Edge;
        counts.edge++;
      } else if (heldOut[Math.floor(y / BLOCK) * bw + Math.floor(x / BLOCK)]) {
        labels[i] = Label.Check;
        counts.check++;
        checkIdx.push(i);
      } else {
        labels[i] = Label.Fit;
        counts.fit++;
        fitIdx.push(i);
      }
    }
  }
  return {
    fit: gather(ab, bb, subsample(fitIdx, opts.maxPairs, rand)),
    check: gather(ab, bb, subsample(checkIdx, Math.ceil(opts.maxPairs * opts.holdout), rand)),
    labels,
    counts,
  };
}

function gather(a: Float32Array, b: Float32Array, idx: number[]): Pairs {
  const src = new Float32Array(idx.length * 3);
  const dst = new Float32Array(idx.length * 3);
  idx.forEach((i, k) => {
    for (let c = 0; c < 3; c++) {
      src[k * 3 + c] = a[i * 3 + c];
      dst[k * 3 + c] = b[i * 3 + c];
    }
  });
  return { src, dst };
}

/** Partial Fisher-Yates: a uniform random subset of at most `max` indices. */
function subsample(idx: number[], max: number, rand: () => number): number[] {
  if (idx.length <= max) return idx;
  const a = idx.slice();
  for (let i = 0; i < max; i++) {
    const j = i + Math.floor(rand() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, max);
}

/** Relative luminance (Y) of Display P3 encoded RGB. */
function luminance(rgb: Float32Array): Float32Array {
  const y = new Float32Array(rgb.length / 3);
  for (let i = 0; i < y.length; i++) {
    y[i] = 0.2289746 * decode(rgb[i * 3]) + 0.6917385 * decode(rgb[i * 3 + 1]) + 0.0792869 * decode(rgb[i * 3 + 2]);
  }
  return y;
}

/** Sobel magnitude on an encoded-ish signal: cube root of luminance (close to L*). */
function gradient(lum: Float32Array, w: number, h: number): Float32Array {
  const l = lum.map(Math.cbrt);
  const g = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = l[i - w + 1] + 2 * l[i + 1] + l[i + w + 1] - l[i - w - 1] - 2 * l[i - 1] - l[i + w - 1];
      const gy = l[i + w - 1] + 2 * l[i + w] + l[i + w + 1] - l[i - w - 1] - 2 * l[i - w] - l[i - w + 1];
      g[i] = Math.hypot(gx, gy);
    }
  }
  return g;
}

/** Separable Gaussian on interleaved RGB, edges clamped. */
export function blur(rgb: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) return rgb.slice();
  const r = Math.ceil(3 * sigma);
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const sum = k.reduce((s, v) => s + v, 0);
  const kn = k.map((v) => v / sum);
  const tmp = new Float32Array(rgb.length);
  const out = new Float32Array(rgb.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let j = -r; j <= r; j++) s += kn[j + r] * rgb[(y * w + Math.min(w - 1, Math.max(0, x + j))) * 3 + c];
        tmp[(y * w + x) * 3 + c] = s;
      }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let j = -r; j <= r; j++) s += kn[j + r] * tmp[(Math.min(h - 1, Math.max(0, y + j)) * w + x) * 3 + c];
        out[(y * w + x) * 3 + c] = s;
      }
  return out;
}

/** Square erosion: a pixel stays valid only if every pixel within `r` is valid. */
function erode(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const pass = (src: Uint8Array, horizontal: boolean) => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let ok = 1;
        for (let j = -r; j <= r && ok; j++) {
          const xx = horizontal ? x + j : x;
          const yy = horizontal ? y : y + j;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || !src[yy * w + xx]) ok = 0;
        }
        out[y * w + x] = ok;
      }
    return out;
  };
  return pass(pass(m, true), false);
}

/** Small seeded PRNG so a given set of options always picks the same pixels. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How well the warped source lines up with the target: the correlation of their
 * high-pass luminance (detail minus a σ = 4 px blur) over the overlap. 1 means the
 * fine structure coincides; near 0 means it does not. On 286 test pairs, below 0.6
 * most fits were poor, so the UI asks for better points under that value.
 */
export function alignmentScore(warped: Float32Array, valid: Uint8Array, target: Float32Array, w: number, h: number): number {
  const keep = erode(valid, w, h, 13);
  const ha = highPass(luminance(warped).map(Math.cbrt), w, h, 4);
  const hb = highPass(luminance(target).map(Math.cbrt), w, h, 4);
  let n = 0, sa = 0, sb = 0;
  for (let i = 0; i < w * h; i++) if (keep[i]) (n++, (sa += ha[i]), (sb += hb[i]));
  if (n < 1000) return NaN;
  const ma = sa / n, mb = sb / n;
  let cab = 0, caa = 0, cbb = 0;
  for (let i = 0; i < w * h; i++) {
    if (!keep[i]) continue;
    const da = ha[i] - ma, db = hb[i] - mb;
    cab += da * db;
    caa += da * da;
    cbb += db * db;
  }
  return cab / Math.sqrt(caa * cbb);
}

function highPass(l: Float32Array, w: number, h: number, sigma: number): Float32Array {
  // Reuse the RGB blur by giving it one channel three times.
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = l[i];
  const b = blur(rgb, w, h, sigma);
  return l.map((v, i) => v - b[i * 3]);
}
