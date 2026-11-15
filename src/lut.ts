// A 3D LUT as a flat table, its trilinear lookup, and the .cube writer.

export interface Lut {
  size: number;
  /** size^3 RGB triplets, red index changing fastest (the .cube order). */
  data: Float32Array;
}

export function identityLut(size: number): Lut {
  const data = new Float32Array(size ** 3 * 3);
  const s = size - 1;
  for (let b = 0, o = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++, o += 3) {
        data[o] = r / s;
        data[o + 1] = g / s;
        data[o + 2] = b / s;
      }
  return { size, data };
}

/**
 * Trilinear interpolation: the input falls in one lattice cell, and the output is
 * the weighted average of the cell's 8 corners. Inputs are clamped to [0, 1].
 * `out` receives the result at `o`.
 */
export function lookup(lut: Lut, r: number, g: number, b: number, out: Float32Array | number[], o = 0): void {
  const s = lut.size - 1;
  const fr = clamp01(r) * s;
  const fg = clamp01(g) * s;
  const fb = clamp01(b) * s;
  const r0 = Math.min(Math.floor(fr), s - 1);
  const g0 = Math.min(Math.floor(fg), s - 1);
  const b0 = Math.min(Math.floor(fb), s - 1);
  const dr = fr - r0;
  const dg = fg - g0;
  const db = fb - b0;
  const n = lut.size;
  const d = lut.data;
  const i000 = ((b0 * n + g0) * n + r0) * 3;
  const i100 = i000 + 3;
  const i010 = i000 + n * 3;
  const i110 = i010 + 3;
  const i001 = i000 + n * n * 3;
  const i101 = i001 + 3;
  const i011 = i001 + n * 3;
  const i111 = i011 + 3;
  for (let c = 0; c < 3; c++) {
    const c00 = d[i000 + c] + (d[i100 + c] - d[i000 + c]) * dr;
    const c10 = d[i010 + c] + (d[i110 + c] - d[i010 + c]) * dr;
    const c01 = d[i001 + c] + (d[i101 + c] - d[i001 + c]) * dr;
    const c11 = d[i011 + c] + (d[i111 + c] - d[i011 + c]) * dr;
    const c0 = c00 + (c10 - c00) * dg;
    const c1 = c01 + (c11 - c01) * dg;
    out[o + c] = c0 + (c1 - c0) * db;
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Adobe Cube LUT Specification 1.0. Values are clamped to the [0, 1] domain. */
export function toCube(lut: Lut, title: string, comments: string[] = []): string {
  const lines = [
    ...comments.map((c) => `# ${c}`),
    `TITLE "${title.replace(/"/g, "'")}"`,
    `LUT_3D_SIZE ${lut.size}`,
    "DOMAIN_MIN 0.0 0.0 0.0",
    "DOMAIN_MAX 1.0 1.0 1.0",
  ];
  const d = lut.data;
  for (let i = 0; i < d.length; i += 3) {
    lines.push(`${clamp01(d[i]).toFixed(6)} ${clamp01(d[i + 1]).toFixed(6)} ${clamp01(d[i + 2]).toFixed(6)}`);
  }
  return lines.join("\n") + "\n";
}
