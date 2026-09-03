"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { CATEGORIES } from "../lib/shop-types";

// The "search-filter" primitive's real UI — a real query against
// /api/shop/products via the URL's own search params, so the server
// component re-renders with real filtered results (no client-side fetch
// needed, no stale state to keep in sync).
export function ShopSearch() {
  const router = useRouter();
  const searchParams = useSearchParams();

  function updateParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    router.push(`/shop?${params.toString()}`);
  }

  return (
    <div className="flex gap-3">
      <input
        data-ai="shop-search-input"
        defaultValue={searchParams.get("q") ?? ""}
        onChange={(e) => updateParam("q", e.target.value)}
        placeholder="Search products…"
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900"
      />
      <select
        data-ai="shop-category-filter"
        defaultValue={searchParams.get("category") ?? ""}
        onChange={(e) => updateParam("category", e.target.value)}
        className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700"
      >
        <option value="">All categories</option>
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </div>
  );
}
