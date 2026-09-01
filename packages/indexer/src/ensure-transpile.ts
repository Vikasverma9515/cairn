// `cairn setup`'s other departure from `init`'s "never touch an existing
// file" rule, for the same class of reason as inject-widget.ts: without
// this, @cairnvibe/sdk and @cairnvibe/core — which ship raw, untranspiled
// .tsx/.ts as their main entry deliberately, so bundlers apply the
// *consuming* project's own JSX/TS settings — have no instruction telling
// Next.js to transform that source at all. Found live, not theoretical:
// a real project on Next.js 16 + Turbopack failed cold with "Unknown
// module type" on @cairnvibe/sdk/src/index.tsx the moment `next dev` ran,
// because nothing in that project's next.config.ts listed it in
// transpilePackages. Fixing that one project by hand isn't the fix — every
// consuming project needs this, automatically, which is what this does.

import fs from "node:fs";
import path from "node:path";
import { Project, SyntaxKind, type ObjectLiteralExpression, type Expression, type SourceFile } from "ts-morph";

export interface TranspileResult {
  ok: boolean;
  filePath?: string;
  created?: boolean; // true if a brand-new config file was written
  reason?: string; // why not, when ok is false
}

const REQUIRED_PACKAGES = ["@cairnvibe/sdk", "@cairnvibe/core"];
const CONFIG_CANDIDATES = ["next.config.ts", "next.config.mjs", "next.config.js", "next.config.cjs"];

function findConfigFile(absDir: string): string | null {
  for (const name of CONFIG_CANDIDATES) {
    const p = path.join(absDir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Resolves `export default X` / `module.exports = X` down to the actual
 * object literal, following one level of `const nextConfig = {...}`
 * indirection — covers the two shapes basically every real Next.js
 * config file uses. Anything else (a config wrapped in a plugin function
 * call like `withSentryConfig(nextConfig)`) returns null on purpose —
 * safely falling back to printed instructions beats guessing which
 * argument of an arbitrary function call is the "real" config. */
function resolveConfigObject(sf: SourceFile, expr: Expression | undefined): ObjectLiteralExpression | null {
  if (!expr) return null;
  if (expr.getKind() === SyntaxKind.ObjectLiteralExpression) return expr as ObjectLiteralExpression;
  if (expr.getKind() === SyntaxKind.Identifier) {
    const varDecl = sf.getVariableDeclaration(expr.getText());
    const init = varDecl?.getInitializer();
    if (init?.getKind() === SyntaxKind.ObjectLiteralExpression) return init as ObjectLiteralExpression;
  }
  return null;
}

function findExportedConfigObject(sf: SourceFile): ObjectLiteralExpression | null {
  // `export default X;`
  const defaultExport = sf.getExportAssignments()[0];
  if (defaultExport) {
    const resolved = resolveConfigObject(sf, defaultExport.getExpression());
    if (resolved) return resolved;
  }
  // `module.exports = X;`
  const moduleExports = sf
    .getDescendantsOfKind(SyntaxKind.BinaryExpression)
    .find((b) => b.getOperatorToken().getText() === "=" && b.getLeft().getText() === "module.exports");
  if (moduleExports) {
    const resolved = resolveConfigObject(sf, moduleExports.getRight());
    if (resolved) return resolved;
  }
  return null;
}

export function ensureTranspilePackages(dir: string): TranspileResult {
  const absDir = path.resolve(dir);
  const existing = findConfigFile(absDir);

  if (!existing) {
    // No config at all yet — the simplest possible one, ESM since that's
    // what every current Next.js version accepts for a fresh project.
    const newPath = path.join(absDir, "next.config.mjs");
    fs.writeFileSync(
      newPath,
      `/** @type {import('next').NextConfig} */\nconst nextConfig = {\n  transpilePackages: ${JSON.stringify(REQUIRED_PACKAGES)},\n};\n\nexport default nextConfig;\n`,
    );
    return { ok: true, filePath: newPath, created: true };
  }

  const relTarget = path.relative(absDir, existing) || existing;
  const manualHint = `add manually: transpilePackages: ${JSON.stringify(REQUIRED_PACKAGES)}`;

  try {
    const project = new Project({ useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true });
    const sf = project.addSourceFileAtPath(existing);
    const configObject = findExportedConfigObject(sf);

    if (!configObject) {
      return { ok: false, reason: `couldn't confidently find the config object in ${relTarget} (it may be wrapped in a plugin function) — ${manualHint}` };
    }

    const existingProp = configObject.getProperty("transpilePackages");
    if (existingProp?.getKind() === SyntaxKind.PropertyAssignment) {
      const initializer = existingProp.asKindOrThrow(SyntaxKind.PropertyAssignment).getInitializer();
      if (initializer?.getKind() !== SyntaxKind.ArrayLiteralExpression) {
        return { ok: false, reason: `${relTarget}'s transpilePackages isn't a plain array — ${manualHint}` };
      }
      const arr = initializer.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
      const current = arr.getElements().map((e) => e.getText().replace(/^["']|["']$/g, ""));
      const toAdd = REQUIRED_PACKAGES.filter((p) => !current.includes(p));
      if (toAdd.length === 0) {
        return { ok: false, reason: `${relTarget} already lists these packages — leaving it alone` };
      }
      for (const pkg of toAdd) arr.addElement(`"${pkg}"`);
    } else {
      configObject.addPropertyAssignment({ name: "transpilePackages", initializer: JSON.stringify(REQUIRED_PACKAGES) });
    }

    sf.saveSync();
    return { ok: true, filePath: existing };
  } catch (err) {
    return { ok: false, reason: `couldn't safely modify ${relTarget} (${(err as Error).message}) — ${manualHint}` };
  }
}
