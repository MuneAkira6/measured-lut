import { expect, it } from "vitest";
import { identityLut } from "../src/lut";
import { deltaEStats } from "../src/report";

it("is zero for identical colours and unchanged by an identity LUT", () => {
  const src = Float32Array.from([0.2, 0.4, 0.6, 0.9, 0.1, 0.3, 0.5, 0.5, 0.5]);
  const shifted = src.map((v, i) => (i % 3 === 0 ? v + 0.05 : v));
  expect(deltaEStats({ src, dst: src }).p95).toBe(0);
  const before = deltaEStats({ src, dst: shifted });
  const after = deltaEStats({ src, dst: shifted }, identityLut(33));
  expect(before.median).toBeGreaterThan(1);
  expect(after.median).toBeCloseTo(before.median, 4);
});
