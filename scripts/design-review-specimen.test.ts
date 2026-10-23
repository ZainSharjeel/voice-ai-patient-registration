import { expect, test } from "bun:test";
import { specimenClip } from "./design-review-specimen";

test("clips padding at the right and bottom page edges", () => {
  expect(
    specimenClip(
      { x: 1400, y: 870, width: 40, height: 30 },
      { width: 1440, height: 900 },
    ),
  ).toEqual({ x: 1376, y: 846, width: 64, height: 54 });
});

test("clips top and left padding without shifting the far edges", () => {
  expect(
    specimenClip(
      { x: 0, y: 0, width: 100, height: 50 },
      { width: 1440, height: 900 },
    ),
  ).toEqual({ x: 0, y: 0, width: 124, height: 74 });
});

test("uses document coordinates on a scrolled long page", () => {
  expect(
    specimenClip(
      { x: 100, y: 1500, width: 300, height: 80 },
      { width: 1440, height: 1600 },
    ),
  ).toEqual({ x: 76, y: 1476, width: 348, height: 124 });
});

test("skips boxes wholly outside the screenshot", () => {
  for (const box of [
    { x: 1500, y: 20, width: 100, height: 50 },
    { x: 20, y: -100, width: 100, height: 50 },
    { x: 20, y: 1000, width: 100, height: 50 },
  ]) {
    expect(specimenClip(box, { width: 1440, height: 900 })).toBeNull();
  }
});
