// Colour conversions used by the fitter and the error report.
// Every function here is checked against colour-science in tests/color.test.ts.

export type Vec3 = [number, number, number];
export type Mat3 = [Vec3, Vec3, Vec3];

/** The two RGB spaces the tool reads. Both use the sRGB transfer curve. */
export type RgbSpace = "srgb" | "display-p3";

// Display P3: DCI-P3 primaries with a D65 white (x, y).
const P3_PRIMARIES: [number, number][] = [
  [0.68, 0.32],
  [0.265, 0.69],
  [0.15, 0.06],
];
const D65_XY: [number, number] = [0.3127, 0.329];

/** XYZ of the D65 white with Y = 1. */
export const D65: Vec3 = xyToXyz(D65_XY);

function xyToXyz([x, y]: [number, number]): Vec3 {
  return [x / y, 1, (1 - x - y) / y];
}

/** sRGB / Display P3 transfer curve: encoded value -> linear light. */
export function decode(v: number): number {
  const a = Math.abs(v);
  const r = a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4;
  return v < 0 ? -r : r;
}

/** Linear light -> encoded value (inverse of `decode`). */
export function encode(v: number): number {
  const a = Math.abs(v);
  const r = a <= 0.0031308 ? a * 12.92 : 1.055 * a ** (1 / 2.4) - 0.055;
  return v < 0 ? -r : r;
}

export function mul(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

export function matMul(a: Mat3, b: Mat3): Mat3 {
  const col = (j: number): Vec3 => [b[0][j], b[1][j], b[2][j]];
  const c = [col(0), col(1), col(2)].map((v) => mul(a, v));
  return [
    [c[0][0], c[1][0], c[2][0]],
    [c[0][1], c[1][1], c[2][1]],
    [c[0][2], c[1][2], c[2][2]],
  ];
}

export function invert(m: Mat3): Mat3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

/**
 * Linear RGB -> XYZ matrix from primaries and white point:
 * scale each primary's XYZ so that RGB (1, 1, 1) lands on the white.
 */
function rgbToXyzMatrix(primaries: [number, number][]): Mat3 {
  const p = primaries.map(xyToXyz);
  const P: Mat3 = [
    [p[0][0], p[1][0], p[2][0]],
    [p[0][1], p[1][1], p[2][1]],
    [p[0][2], p[1][2], p[2][2]],
  ];
  const s = mul(invert(P), D65);
  return P.map((row) => [row[0] * s[0], row[1] * s[1], row[2] * s[2]]) as Mat3;
}

export const RGB_TO_XYZ: Record<RgbSpace, Mat3> = {
  // IEC 61966-2-1 publishes this matrix rounded to 4 decimals; colour-science and
  // most CMMs use the published one. It differs from the derived matrix by ~1e-5.
  srgb: [
    [0.4124, 0.3576, 0.1805],
    [0.2126, 0.7152, 0.0722],
    [0.0193, 0.1192, 0.9505],
  ],
  "display-p3": rgbToXyzMatrix(P3_PRIMARIES),
};

/** Linear sRGB -> linear Display P3 (same white, so no adaptation needed). */
export const SRGB_TO_P3: Mat3 = matMul(invert(RGB_TO_XYZ["display-p3"]), RGB_TO_XYZ.srgb);

/** Encoded RGB in `space` -> XYZ (D65, Y of white = 1). */
export function rgbToXyz(rgb: Vec3, space: RgbSpace): Vec3 {
  return mul(RGB_TO_XYZ[space], [decode(rgb[0]), decode(rgb[1]), decode(rgb[2])]);
}

const EPS = 216 / 24389;
const KAPPA = 24389 / 27;

/** XYZ -> CIELAB relative to D65. */
export function xyzToLab(xyz: Vec3): Vec3 {
  const f = (t: number) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
  const fx = f(xyz[0] / D65[0]);
  const fy = f(xyz[1] / D65[1]);
  const fz = f(xyz[2] / D65[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const DEG = Math.PI / 180;

/** CIEDE2000 (Sharma, Wu & Dalal 2005), kL = kC = kH = 1. */
export function deltaE2000(lab1: Vec3, lab2: Vec3): number {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const Cbar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (b: number, a: number) => (b === 0 && a === 0 ? 0 : (Math.atan2(b, a) / DEG + 360) % 360);
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * DEG);

  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbp /= 2;
    else hbp = h1p + h2p < 360 ? (hbp + 360) / 2 : (hbp - 360) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hbp - 30) * DEG) +
    0.24 * Math.cos(2 * hbp * DEG) +
    0.32 * Math.cos((3 * hbp + 6) * DEG) -
    0.2 * Math.cos((4 * hbp - 63) * DEG);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const SC = 1 + 0.045 * Cbp;
  const SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(2 * dTheta * DEG) * RC;
  return Math.sqrt(
    (dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH),
  );
}
