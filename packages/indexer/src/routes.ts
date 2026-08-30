import path from "node:path";

/**
 * Next.js App Router route derivation from a `page.tsx` path.
 * `app/page.tsx` -> "/"
 * `app/invoices/page.tsx` -> "/invoices"
 * `app/(marketing)/about/page.tsx` -> "/about"   (route groups are stripped)
 * `app/invoices/[id]/page.tsx` -> "/invoices/[id]"
 */
export function routeFromPagePath(rootDir: string, pageFilePath: string): string {
  const rel = path.relative(path.join(rootDir, "app"), pageFilePath);
  const withoutFile = rel.replace(/(^|[\\/])page\.(tsx|ts|jsx|js)$/, "");
  const segments = withoutFile
    .split(path.sep)
    .filter((seg) => seg.length > 0 && !/^\(.*\)$/.test(seg));
  return "/" + segments.join("/");
}
