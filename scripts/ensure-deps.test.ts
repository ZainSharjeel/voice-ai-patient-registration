import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkNodeModules } from "./ensure-deps";

let root: string;
let project: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ensure-deps-"));
  project = join(root, "project");
  mkdirSync(project);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function populate(dir: string): void {
  mkdirSync(join(dir, ".bin"), { recursive: true });
  writeFileSync(join(dir, ".bin", "vite"), "");
}

describe("checkNodeModules", () => {
  test("a plain, complete node_modules directory is healthy", () => {
    populate(join(project, "node_modules"));
    expect(checkNodeModules(project)).toEqual({ healthy: true });
  });

  test("a symlink into a complete target is healthy", () => {
    const target = join(root, "viktor-node-modules", "abc", "node_modules");
    populate(target);
    symlinkSync(target, join(project, "node_modules"));
    expect(checkNodeModules(project)).toEqual({ healthy: true });
  });

  test("a missing node_modules needs an install", () => {
    const health = checkNodeModules(project);
    expect(health.healthy).toBe(false);
    expect(health).not.toHaveProperty("linkTarget");
  });

  test("a dangling symlink reports its target so it can be recreated", () => {
    const target = join(root, "viktor-node-modules", "gone", "node_modules");
    symlinkSync(target, join(project, "node_modules"));
    expect(checkNodeModules(project)).toEqual({
      healthy: false,
      reason: `node_modules links to ${target}, which no longer exists`,
      linkTarget: target,
    });
  });

  test("a relative symlink resolves against the project", () => {
    const target = join(root, "store", "node_modules");
    symlinkSync("../store/node_modules", join(project, "node_modules"));
    const health = checkNodeModules(project);
    expect(health.healthy).toBe(false);
    if (!health.healthy) expect(health.linkTarget).toBe(target);
  });

  test("a symlink into an empty target needs an install", () => {
    const target = join(root, "viktor-node-modules", "empty", "node_modules");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(project, "node_modules"));
    expect(checkNodeModules(project)).toEqual({
      healthy: false,
      reason: "node_modules/.bin/vite is missing (incomplete install)",
    });
  });

  test("an install without vite is incomplete", () => {
    mkdirSync(join(project, "node_modules", "react"), { recursive: true });
    const health = checkNodeModules(project);
    expect(health.healthy).toBe(false);
    if (!health.healthy) expect(health.reason).toContain(".bin/vite");
  });
});
