// Fit a 3D LUT to colour pairs by lattice regression.
//
// Garcia & Gupta, "Lattice Regression", NIPS 2009, and Garcia, Arora & Gupta,
// "Optimized Regression for Efficient Function Evaluation", IEEE TIP 2012:
// solve for the lattice values directly, so that the LUT *after trilinear
// interpolation* matches the samples, instead of fitting some function first and
// sampling it onto the lattice afterwards.
//
// Unknowns: r = LUT - prior, one value per lattice node and channel.
// Minimise, per channel,
//   (1/Σω) Σ_i ω_i (Σ_c w_ic r_c - (y_i - prior(x_i)))^2      data, trilinear weights w
//   + λ R(r)                                                   thin-plate smoothness
//   + Σ_j γ_j r_j^2                                             pull far nodes to the prior
// R is the discrete thin-plate energy: squared second differences along each
// axis plus twice the squared mixed differences (Gupta et al., JMLR 2016, eq. 11
// calls the mixed term "torsion"). Its null space is exactly the affine
// functions, so sparse regions are filled by smooth, near-linear continuation
// rather than flattened (which is what a first-order Laplacian does).
// Second-order terms alone extrapolate linearly and can run far out of range
// in empty corners, so nodes far from any sample get a ridge term γ_j that
// pulls them back to the prior.
//
// The system is symmetric positive definite; we solve it with Jacobi-
// preconditioned conjugate gradients and never build the matrix: CG only needs
// "matrix times vector", which is one pass over the samples and one over the
// lattice.

import { decode, encode, type Mat3 } from "./color";
import { lookup, type Lut } from "./lut";
import type { Pairs } from "./samples";

export interface FitOptions {
  size: number;
  /** Multiplies the default λ; the UI exposes it on a log scale. */
  smoothness: number;
  /** What the LUT falls back to where there is no data. */
  prior: "identity" | "matrix";
  /** Per-cell weight cap: a cell with more pairs than this counts as this many. */
  cellCap: number;
}

export const DEFAULT_FIT_OPTIONS: FitOptions = { size: 33, smoothness: 1, prior: "matrix", cellCap: 50 };

/** λ and γ0 for a data term that is a weighted mean over pairs in 0..1 units. */
const LAMBDA = 5e-6;
const GAMMA0 = 1e-6;

export interface FitResult {
  lut: Lut;
  /** Linear-light 3x3 matrix used as the prior (identity if prior = "identity"). */
  matrix: Mat3;
  iterations: number;
  ms: number;
}

export function fitLut(pairs: Pairs, options: Partial<FitOptions> = {}): FitResult {
  const t0 = performance.now();
  const opts = { ...DEFAULT_FIT_OPTIONS, ...options };
  const N = opts.size;
  const S = N - 1;
  const nodes = N ** 3;
  const n = pairs.src.length / 3;
  const lambda = LAMBDA * opts.smoothness;

  // Trilinear weights of each sample: the base node of its cell and 8 weights.
  const base = new Int32Array(n);
  const w = new Float64Array(n * 8);
  const cellCount = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const u = [0, 1, 2].map((c) => clamp01(pairs.src[i * 3 + c]) * S);
    const i0 = u.map((v) => Math.min(Math.floor(v), S - 1));
    const f = u.map((v, c) => v - i0[c]);
    base[i] = (i0[2] * N + i0[1]) * N + i0[0];
    for (let k = 0; k < 8; k++) {
      w[i * 8 + k] = (k & 1 ? f[0] : 1 - f[0]) * (k & 2 ? f[1] : 1 - f[1]) * (k & 4 ? f[2] : 1 - f[2]);
    }
    cellCount.set(base[i], (cellCount.get(base[i]) ?? 0) + 1);
  }
  // Offsets of the 8 cell corners from the base node, in the same bit order (r = bit 0).
  const corner = Array.from({ length: 8 }, (_, k) => (k & 1 ? 1 : 0) + (k & 2 ? N : 0) + (k & 4 ? N * N : 0));

  // Weights: a big flat wall or sky should not outvote everything else.
  const omega = new Float64Array(n);
  let omegaSum = 0;
  for (let i = 0; i < n; i++) {
    omega[i] = Math.min(1, opts.cellCap / cellCount.get(base[i])!);
    omegaSum += omega[i];
  }
  for (let i = 0; i < n; i++) omega[i] /= omegaSum || 1;

  // Prior: identity, or a 3x3 matrix in linear light fitted to the same pairs.
  const matrix = opts.prior === "matrix" ? fitMatrix(pairs, omega) : IDENTITY;
  const prior = new Float64Array(nodes * 3);
  for (let b = 0, j = 0; b < N; b++)
    for (let g = 0; g < N; g++)
      for (let r = 0; r < N; r++, j++) {
        const lin = [decode(r / S), decode(g / S), decode(b / S)];
        for (let c = 0; c < 3; c++) {
          prior[j * 3 + c] = encode(matrix[c][0] * lin[0] + matrix[c][1] * lin[1] + matrix[c][2] * lin[2]);
        }
      }

  // Ridge strength from each node's lattice distance to the nearest node with data.
  const gamma = ridge(base, corner, N);

  // Jacobi preconditioner: the diagonal of the system matrix.
  const diag = new Float64Array(nodes);
  for (let i = 0; i < n; i++) for (let k = 0; k < 8; k++) diag[base[i] + corner[k]] += omega[i] * w[i * 8 + k] ** 2;
  thinPlate(N, (idx, coef) => {
    for (let m = 0; m < idx.length; m++) diag[idx[m]] += lambda * coef[m] * coef[m];
  });
  for (let j = 0; j < nodes; j++) diag[j] += gamma[j];

  const applyA = (v: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (let i = 0; i < n; i++) {
      const o = i * 8;
      let s = 0;
      for (let k = 0; k < 8; k++) s += w[o + k] * v[base[i] + corner[k]];
      s *= omega[i];
      for (let k = 0; k < 8; k++) out[base[i] + corner[k]] += w[o + k] * s;
    }
    thinPlate(N, (idx, coef, d) => {
      // d is Σ coef·v over the stencil, filled in by thinPlate when v is given.
      for (let m = 0; m < idx.length; m++) out[idx[m]] += lambda * coef[m] * d!;
    }, v);
    for (let j = 0; j < nodes; j++) out[j] += gamma[j] * v[j];
  };

  const data = new Float64Array(nodes * 3);
  let iterations = 0;
  for (let c = 0; c < 3; c++) {
    const priorC = Float64Array.from({ length: nodes }, (_, j) => prior[j * 3 + c]);
    // Right-hand side: W^T Ω (y - prior interpolated at x).
    const rhs = new Float64Array(nodes);
    for (let i = 0; i < n; i++) {
      const o = i * 8;
      let p = 0;
      for (let k = 0; k < 8; k++) p += w[o + k] * priorC[base[i] + corner[k]];
      const t = omega[i] * (pairs.dst[i * 3 + c] - p);
      for (let k = 0; k < 8; k++) rhs[base[i] + corner[k]] += w[o + k] * t;
    }
    const { x, iterations: it } = pcg(applyA, rhs, diag, 1e-5, 3000);
    iterations = Math.max(iterations, it);
    for (let j = 0; j < nodes; j++) data[j * 3 + c] = clamp01(priorC[j] + x[j]);
  }
  return { lut: { size: N, data: Float32Array.from(data) }, matrix, iterations, ms: performance.now() - t0 };
}

const IDENTITY: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/**
 * Visit every thin-plate stencil (natural boundary: only stencils that fit inside
 * the lattice). For an axis, the stencil is (1, -2, 1) along it; for a pair of
 * axes, the 4 corners of a face with (1, -1, -1, 1), weighted by sqrt 2 so that
 * its square carries the factor 2. If `v` is given, the stencil's value Σ coef·v
 * is passed as `d`.
 */
function thinPlate(
  N: number,
  visit: (idx: number[], coef: number[], d?: number) => void,
  v?: Float64Array,
): void {
  const stride = [1, N, N * N];
  const axial = [1, -2, 1];
  const r2 = Math.SQRT2;
  const mixed = [r2, -r2, -r2, r2];
  const idx3 = [0, 0, 0];
  const idx4 = [0, 0, 0, 0];
  for (let b = 0; b < N; b++)
    for (let g = 0; g < N; g++)
      for (let r = 0; r < N; r++) {
        const j = (b * N + g) * N + r;
        const pos = [r, g, b];
        for (let k = 0; k < 3; k++) {
          if (pos[k] === 0 || pos[k] === N - 1) continue;
          idx3[0] = j - stride[k];
          idx3[1] = j;
          idx3[2] = j + stride[k];
          visit(idx3, axial, v ? v[idx3[0]] - 2 * v[j] + v[idx3[2]] : undefined);
        }
        for (let k = 0; k < 3; k++)
          for (let l = k + 1; l < 3; l++) {
            if (pos[k] === N - 1 || pos[l] === N - 1) continue;
            idx4[0] = j;
            idx4[1] = j + stride[k];
            idx4[2] = j + stride[l];
            idx4[3] = j + stride[k] + stride[l];
            visit(idx4, mixed, v ? r2 * (v[idx4[0]] - v[idx4[1]] - v[idx4[2]] + v[idx4[3]]) : undefined);
          }
      }
}

/** γ_j = γ0 · clamp((d_j - 1) / 3, 0, 1), d_j = BFS distance to a node touched by data. */
function ridge(base: Int32Array, corner: number[], N: number): Float64Array {
  const nodes = N ** 3;
  const dist = new Int32Array(nodes).fill(-1);
  const queue = new Int32Array(nodes);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < base.length; i++)
    for (const off of corner) {
      const j = base[i] + off;
      if (dist[j] < 0) {
        dist[j] = 0;
        queue[tail++] = j;
      }
    }
  while (head < tail) {
    const j = queue[head++];
    const r = j % N;
    const g = Math.floor(j / N) % N;
    const b = Math.floor(j / (N * N));
    const nb: number[] = [];
    if (r > 0) nb.push(j - 1);
    if (r < N - 1) nb.push(j + 1);
    if (g > 0) nb.push(j - N);
    if (g < N - 1) nb.push(j + N);
    if (b > 0) nb.push(j - N * N);
    if (b < N - 1) nb.push(j + N * N);
    for (const k of nb) {
      if (dist[k] < 0) {
        dist[k] = dist[j] + 1;
        queue[tail++] = k;
      }
    }
  }
  return Float64Array.from(dist, (d) => (d < 0 ? GAMMA0 : GAMMA0 * Math.min(1, Math.max(0, (d - 1) / 3))));
}

/** Weighted least squares for a 3x3 matrix in linear light: B ≈ M A. */
function fitMatrix(pairs: Pairs, omega: Float64Array): Mat3 {
  const n = omega.length;
  if (n < 10) return IDENTITY;
  // Normal equations: (Σ ω a aᵀ) Mᵀ = Σ ω a bᵀ.
  const AtA = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const AtB = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const a = [0, 1, 2].map((c) => decode(pairs.src[i * 3 + c]));
    const b = [0, 1, 2].map((c) => decode(pairs.dst[i * 3 + c]));
    for (let p = 0; p < 3; p++)
      for (let q = 0; q < 3; q++) {
        AtA[p * 3 + q] += omega[i] * a[p] * a[q];
        AtB[p * 3 + q] += omega[i] * a[p] * b[q];
      }
  }
  const inv = invert3(AtA);
  if (!inv) return IDENTITY;
  const Mt = [0, 1, 2].map((p) => [0, 1, 2].map((q) => inv[p * 3] * AtB[q] + inv[p * 3 + 1] * AtB[3 + q] + inv[p * 3 + 2] * AtB[6 + q]));
  return [0, 1, 2].map((r) => [Mt[0][r], Mt[1][r], Mt[2][r]]) as Mat3;
}

function invert3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d].map((x) => x / det);
}

/** Jacobi-preconditioned conjugate gradients, stopping at ‖r‖ ≤ rtol·‖b‖. */
export function pcg(
  applyA: (v: Float64Array, out: Float64Array) => void,
  b: Float64Array,
  diag: Float64Array,
  rtol: number,
  maxIter: number,
): { x: Float64Array; iterations: number } {
  const m = b.length;
  const x = new Float64Array(m);
  const r = b.slice();
  const z = r.map((v, j) => v / diag[j]);
  const p = z.slice();
  const Ap = new Float64Array(m);
  let rz = dot(r, z);
  const stop = rtol * Math.sqrt(dot(b, b));
  let it = 0;
  while (it < maxIter && Math.sqrt(dot(r, r)) > stop) {
    applyA(p, Ap);
    const alpha = rz / dot(p, Ap);
    for (let j = 0; j < m; j++) {
      x[j] += alpha * p[j];
      r[j] -= alpha * Ap[j];
      z[j] = r[j] / diag[j];
    }
    const rzNew = dot(r, z);
    const beta = rzNew / rz;
    rz = rzNew;
    for (let j = 0; j < m; j++) p[j] = z[j] + beta * p[j];
    it++;
  }
  return { x, iterations: it };
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let j = 0; j < a.length; j++) s += a[j] * b[j];
  return s;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Exposed for tests: thin-plate energy of a lattice function (one channel). */
export function thinPlateEnergy(N: number, v: Float64Array): number {
  let e = 0;
  thinPlate(N, (_idx, _coef, d) => (e += d! * d!), v);
  return e;
}

/** Exposed for tests: evaluate the LUT at many inputs. */
export function evaluate(lut: Lut, src: Float32Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) lookup(lut, src[i], src[i + 1], src[i + 2], out, i);
  return out;
}
