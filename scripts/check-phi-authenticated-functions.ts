/**
 * Fail a PHI deploy when app code registers unauthenticated Convex functions.
 *
 * Scans convex/ source (excluding _generated/) for functions registered with
 * the raw `query` / `mutation` / `action` builders imported from
 * "./_generated/server". Those builders skip the signed-in-user check, so on
 * PHI deployments every app-facing function must instead use the template's
 * authenticated builders (`authenticatedQuery` / `authenticatedMutation` /
 * `authenticatedAction` from "./functions", convex/functions.ts). The Viktor
 * platform runs this script against the exact source being deployed, before
 * every PHI deploy, and blocks the deploy on any violation.
 *
 * The template's own root modules are allowlisted: they are the audited
 * plumbing that defines the builders (functions.ts) or intentionally serves
 * pre-auth traffic (auth.ts, http.ts).
 * `internal*` builders are not flagged — they are not callable from clients.
 *
 * Usage: bun run --bun scripts/check-phi-authenticated-functions.ts
 * Exits 1 (with one violation per line on stdout) when raw registrations
 * are found; exits 0 when the convex/ source is clean.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
// The project's `typescript` is the native compiler (7.x), which ships no
// parser API; `typescript-api` is the JS-based TypeScript kept for it.
import ts from "typescript-api";
import { collectConvexSourceFiles } from "./generate-phi-console-statics";

/** Raw public registrars from convex/_generated/server that skip auth. */
const RAW_REGISTRARS = new Set(["query", "mutation", "action"]);

/** Module specifiers that resolve to the generated server module. */
const GENERATED_SERVER_SPECIFIER = /(^|\/)_generated\/server$/;

/**
 * Root convex/ modules allowed to use the raw registrars: the template's
 * own audited plumbing. Only files directly in convex/ match — a
 * subdirectory file of the same name is still checked.
 */
export const ALLOWED_ROOT_MODULES = new Set([
  "auth.ts",
  "http.ts",
  "functions.ts",
]);

export interface RawRegistrationViolation {
  /** The registrar as exported by _generated/server: query|mutation|action. */
  registrar: string;
  /** The local name the registrar was called through (may be an alias). */
  localName: string;
  /** 1-based line of the registration call. */
  line: number;
}

/**
 * Find calls to `query` / `mutation` / `action` imported from
 * "./_generated/server" (named, aliased, or via a namespace import) in one
 * source file.
 */
export function findRawRegistrations(
  sourceText: string,
  fileName = "source.ts",
): RawRegistrationViolation[] {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  // Local identifier -> registrar it aliases (handles `query as q`).
  const rawLocals = new Map<string, string>();
  // Locals of `import * as server from "./_generated/server"`.
  const namespaceLocals = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !GENERATED_SERVER_SPECIFIER.test(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaceLocals.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (RAW_REGISTRARS.has(imported)) {
        rawLocals.set(element.name.text, imported);
      }
    }
  }
  if (rawLocals.size === 0 && namespaceLocals.size === 0) return [];

  const violations: RawRegistrationViolation[] = [];
  const record = (
    node: ts.Node,
    registrar: string,
    localName: string,
  ): void => {
    const { line } = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    );
    violations.push({ registrar, localName, line: line + 1 });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && rawLocals.has(callee.text)) {
        record(node, rawLocals.get(callee.text) ?? callee.text, callee.text);
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        namespaceLocals.has(callee.expression.text) &&
        RAW_REGISTRARS.has(callee.name.text)
      ) {
        record(
          node,
          callee.name.text,
          `${callee.expression.text}.${callee.name.text}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

/** True when the file (relative to convex/) is an allowlisted root module. */
export function isAllowedRootModule(relativePath: string): boolean {
  return !relativePath.includes(sep) && ALLOWED_ROOT_MODULES.has(relativePath);
}

export interface FileViolation extends RawRegistrationViolation {
  /** Path relative to the convex/ directory. */
  file: string;
}

export function checkConvexDir(convexDir: string): FileViolation[] {
  const violations: FileViolation[] = [];
  for (const file of collectConvexSourceFiles(convexDir)) {
    const relPath = relative(convexDir, file);
    if (isAllowedRootModule(relPath)) continue;
    const text = readFileSync(file, "utf8");
    for (const violation of findRawRegistrations(text, file)) {
      violations.push({ ...violation, file: relPath });
    }
  }
  return violations;
}

async function main(): Promise<void> {
  const projectRoot = dirname(import.meta.dir);
  const convexDir = join(projectRoot, "convex");
  const violations = checkConvexDir(convexDir);
  if (violations.length === 0) {
    console.log("PHI authenticated-functions check passed.");
    return;
  }
  for (const v of violations) {
    console.log(
      `convex/${v.file}:${v.line} registers a Convex function with ` +
        `\`${v.localName}\` (\`${v.registrar}\` from "./_generated/server"). ` +
        `On PHI deployments use authenticated${v.registrar[0].toUpperCase()}${v.registrar.slice(1)} ` +
        `from "./functions" instead.`,
    );
  }
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
