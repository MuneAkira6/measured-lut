// Homography from point correspondences, and warping one image onto another.

export type Point = [number, number];
/** Row-major 3x3, H[8] is normalised to 1. */
export type Homography = number[];

/**
 * Direct linear transform (Hartley & Zisserman, Multiple View Geometry, 2nd ed., Alg. 4.2).
 * With exactly 4 pairs the system is square and solved exactly; points are normalised
 * first (centroid at 0, mean distance sqrt 2) so the solve is well conditioned on
 * 4000-pixel images.
 */
export function homography(src: Point[], dst: Point[]): Homography {
  if (src.length !== 4 || dst.length !== 4) throw new Error("Need exactly 4 point pairs");
  const [Ts, s] = normalise(src);
  const [Td, d] = normalise(dst);
  // Unknowns h0..h7 with h8 = 1:  u = (h0 x + h1 y + h2) / (h6 x + h7 y + 1), same for v.
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = s[i];
    const [u, v] = d[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  if (!h) throw new Error("Points are degenerate (three of them on one line?)");
  const Hn = [...h, 1];
  // Undo the normalisation: H = Td^-1 * Hn * Ts.
  const H = mul3(mul3(inv3(Td), Hn), Ts);
  return H.map((x) => x / H[8]);
}

export function apply(H: Homography, [x, y]: Point): Point {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function inverse(H: Homography): Homography {
  const I = inv3(H);
  return I.map((x) => x / I[8]);
}

/**
 * Resample `src` (RGB float planes, interleaved) into a `w x h` frame where pixel
 * (x, y) of the output comes from H^-1 (x, y) of the source. Pixels that fall
 * outside the source get valid = 0. Bilinear interpolation.
 */
export function warp(
  src: Float32Array,
  sw: number,
  sh: number,
  H: Homography,
  w: number,
  h: number,
): { rgb: Float32Array; valid: Uint8Array } {
  const Hi = inverse(H);
  const rgb = new Float32Array(w * h * 3);
  const valid = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Pixel centres are at +0.5.
      const [sx, sy] = apply(Hi, [x + 0.5, y + 0.5]);
      const fx = sx - 0.5;
      const fy = sy - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= sw || y0 + 1 >= sh) continue;
      const ax = fx - x0;
      const ay = fy - y0;
      const o = (y * w + x) * 3;
      const i00 = (y0 * sw + x0) * 3;
      const i10 = i00 + 3;
      const i01 = i00 + sw * 3;
      const i11 = i01 + 3;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * ax;
        const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * ax;
        rgb[o + c] = top + (bot - top) * ay;
      }
      valid[y * w + x] = 1;
    }
  }
  return { rgb, valid };
}

function normalise(pts: Point[]): [number[], Point[]] {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const md = pts.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / pts.length;
  const k = md > 0 ? Math.SQRT2 / md : 1;
  const T = [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1];
  return [T, pts.map(([x, y]) => [k * (x - cx), k * (y - cy)] as Point)];
}

/** Gaussian elimination with partial pivoting. Returns null if singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-10) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

function mul3(a: number[], b: number[]): number[] {
  const c = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) c[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return c;
}

function inv3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d].map((x) => x / det);
}
