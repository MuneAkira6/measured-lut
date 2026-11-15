import { expect, it } from "vitest";
import { identityLut, lookup, toCube } from "../src/lut";
import golden from "./golden/color.json";

it("trilinear lookup matches colour-science on a non-linear 5^3 table", () => {
  const lut = { size: golden.lut.size, data: Float32Array.from(golden.lut.data) };
  const out = [0, 0, 0];
  golden.lut.in.forEach(([r, g, b], i) => {
    lookup(lut, r, g, b, out);
    out.forEach((v, c) => expect(v).toBeCloseTo(golden.lut.out[i][c], 6));
  });
});

it("identity LUT returns its input", () => {
  const lut = identityLut(33);
  const out = [0, 0, 0];
  lookup(lut, 0.123, 0.5, 0.987, out);
  expect(out[0]).toBeCloseTo(0.123, 6);
  expect(out[1]).toBeCloseTo(0.5, 6);
  expect(out[2]).toBeCloseTo(0.987, 6);
});

it("writes a .cube with red changing fastest", () => {
  const text = toCube(identityLut(2), "test");
  const rows = text.trim().split("\n").filter((l) => /^[\d.]+ /.test(l));
  expect(text).toContain("LUT_3D_SIZE 2");
  expect(rows).toEqual([
    "0.000000 0.000000 0.000000",
    "1.000000 0.000000 0.000000",
    "0.000000 1.000000 0.000000",
    "1.000000 1.000000 0.000000",
    "0.000000 0.000000 1.000000",
    "1.000000 0.000000 1.000000",
    "0.000000 1.000000 1.000000",
    "1.000000 1.000000 1.000000",
  ]);
});
