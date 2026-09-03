import Link from "next/link";
import { AddToCartButton } from "../../components/AddToCartButton";
import { ShopAuthControls } from "../../components/ShopAuthControls";
import { ShopSearch } from "../../components/ShopSearch";
import { formatCents } from "../../lib/shop-types";
import { isLoggedIn, listCart, listProducts } from "../../lib/shop";

export default function ShopPage({ searchParams }: { searchParams: { q?: string; category?: string } }) {
  const products = listProducts({ q: searchParams.q, category: searchParams.category });
  const cart = listCart();
  const cartCount = cart.reduce((sum, line) => sum + line.quantity, 0);
  const loggedIn = isLoggedIn();

  return (
    <main className="mx-auto max-w-3xl px-8 py-16">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Shop</h1>
          <p className="mt-3 text-gray-600">Search the catalog, add items to your cart, then check out.</p>
        </div>
        <div className="flex items-center gap-3">
          <ShopAuthControls loggedIn={loggedIn} />
          <Link
            data-ai="shop-checkout-link"
            href="/shop/checkout"
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100"
          >
            Cart ({cartCount})
          </Link>
        </div>
      </div>

      <div className="mt-6">
        <ShopSearch />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2" data-ai="shop-product-grid">
        {products.map((p) => (
          <div key={p.id} className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div>
              <div className="text-sm font-medium text-gray-800">{p.name}</div>
              <div className="text-xs text-gray-500">
                {p.category} · {formatCents(p.priceCents)}
              </div>
            </div>
            <AddToCartButton productId={p.id} />
          </div>
        ))}
        {products.length === 0 && <div className="text-sm text-gray-500">No products match your search.</div>}
      </div>
    </main>
  );
}
