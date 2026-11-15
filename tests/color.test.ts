import { describe, expect, it } from "vitest";
import {
  RGB_TO_XYZ,
  SRGB_TO_P3,
  decode,
  deltaE2000,
  encode,
  rgbToXyz,
  xyzToLab,
  type RgbSpace,
  type Vec3,
} from "../src/color";
import golden from "./golden/color.json";

const rgb = golden.rgb as Vec3[];

function close(a: number[], b: number[], tol: number) {
  a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(tol));
}

describe.each(["srgb", "display-p3"] as RgbSpace[])("%s against colour-science", (space) => {
  const ref = golden.spaces[space];

  it("RGB -> XYZ matrix", () => {
    RGB_TO_XYZ[space].forEach((row, i) => close(row, ref.matrix[i], 1e-9));
  });

  it("transfer curve decode, and encode round-trips", () => {
    rgb.forEach((c, i) => {
      const lin = c.map(decode);
      close(lin, ref.linear[i], 1e-12);
      close(lin.map(encode), c, 1e-12);
    });
  });

  it("encoded RGB -> XYZ -> Lab", () => {
    rgb.forEach((c, i) => {
      const xyz = rgbToXyz(c, space);
      close(xyz, ref.xyz[i], 1e-9);
      close(xyzToLab(xyz), ref.lab[i], 1e-6);
    });
  });
});

it("linear sRGB -> linear Display P3 matrix", () => {
  SRGB_TO_P3.forEach((row, i) => close(row, golden.srgb_to_p3[i], 1e-9));
});

it("CIEDE2000 against colour-science, including near-neutral pairs", () => {
  const { lab1, lab2, de } = golden.de2000;
  lab1.forEach((l, i) => {
    expect(deltaE2000(l as Vec3, lab2[i] as Vec3)).toBeCloseTo(de[i], 9);
  });
});
