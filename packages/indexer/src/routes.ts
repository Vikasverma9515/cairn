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

/**
 * Pages Router route derivation.
 * `pages/index.tsx` -> "/"
 * `pages/invoices.tsx` -> "/invoices"
 * `pages/invoices/index.tsx` -> "/invoices"
 * `pages/invoices/[id].tsx` -> "/invoices/[id]"
 * (Caller is responsible for excluding `pages/api/**`, `_app`, `_document`,
 * `_error`, `404`, `500` — those aren't routes.)
 */
export function routeFromPagesRouterPath(rootDir: string, filePath: string): string {
  const rel = path.relative(path.join(rootDir, "pages"), filePath);
  const withoutExt = rel.replace(/\.(tsx|ts|jsx|js)$/, "");
  const segments = withoutExt.split(path.sep).filter((seg) => seg.length > 0);
  if (segments[segments.length - 1] === "index") segments.pop();
  return "/" + segments.join("/");
}
