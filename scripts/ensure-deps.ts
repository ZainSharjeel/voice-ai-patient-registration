// Runs before node_modules is trusted, so it may import only runtime built-ins.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type DepsHealth =
  | { healthy: true }
  | { healthy: false; reason: string; linkTarget?: string };

// In a Viktor sandbox node_modules is a symlink into sandbox-local storage
// (/tmp/viktor-node-modules/<hash>/), which a sandbox restart wipes.
export function checkNodeModules(projectRoot: string): DepsHealth {
  const nodeModules = join(projectRoot, "node_modules");
  let isLink: boolean;
  try {
    isLink = lstatSync(nodeModules).isSymbolicLink();
  } catch {
    return { healthy: false, reason: "node_modules is missing" };
  }

  if (isLink) {
    const linkTarget = resolve(projectRoot, readlinkSync(nodeModules));
    if (!existsSync(linkTarget)) {
      return {
        healthy: false,
        reason: `node_modules links to ${linkTarget}, which no longer exists`,
        linkTarget,
      };
    }
  }

  if (!existsSync(join(nodeModules, ".bin", "vite"))) {
    return {
      healthy: false,
      reason: "node_modules/.bin/vite is missing (incomplete install)",
    };
  }
  return { healthy: true };
}

function bunInstall(projectRoot: string, frozen: boolean): boolean {
  // Same flags as the platform install (hoisted linker, frozen lockfile).
  const args = ["install", "--linker", "hoisted"];
  if (frozen) args.push("--frozen-lockfile");
  console.log(`📦 bun ${args.join(" ")}`);
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    stdio: "inherit",
  });
  return result.status === 0;
}

export function ensureDeps(projectRoot: string): boolean {
  const health = checkNodeModules(projectRoot);
  if (health.healthy) return true;

  console.log(`🔧 ${health.reason}; reinstalling dependencies...`);
  if (health.linkTarget && !existsSync(health.linkTarget)) {
    mkdirSync(health.linkTarget, { recursive: true });
    console.log(`📁 Recreated ${health.linkTarget}`);
  }
  if (!bunInstall(projectRoot, true)) {
    console.log(
      "⚠️  Frozen install failed (package.json and bun.lock disagree); retrying with a lockfile update.",
    );
    if (!bunInstall(projectRoot, false)) return false;
  }

  const after = checkNodeModules(projectRoot);
  if (!after.healthy) {
    console.error(`❌ Dependencies still broken: ${after.reason}`);
    return false;
  }
  console.log("✅ Dependencies restored");
  return true;
}

if (import.meta.main) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (!ensureDeps(projectRoot)) {
    console.error(
      "❌ Could not restore node_modules. Run `deploy_app`, which resets and repairs the node_modules layout. Never delete node_modules or bun.lock.",
    );
    process.exit(1);
  }
}
