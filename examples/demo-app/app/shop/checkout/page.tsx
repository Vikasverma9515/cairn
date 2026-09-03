import Link from "next/link";
import { CheckoutWizard } from "../../../components/CheckoutWizard";
import { ShopAuthControls } from "../../../components/ShopAuthControls";
import { isLoggedIn, listCart } from "../../../lib/shop";

export default function CheckoutPage() {
  const loggedIn = isLoggedIn();
  const cart = listCart();

  return (
    <main className="mx-auto max-w-xl px-8 py-16">
      <Link href="/shop" className="text-sm text-gray-500 hover:text-gray-800">
        ← Back to shop
      </Link>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-gray-900">Checkout</h1>

      {!loggedIn ? (
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800" data-ai="shop-auth-gate">
          You need to log in before checking out.
          <div className="mt-3">
            <ShopAuthControls loggedIn={false} />
          </div>
        </div>
      ) : cart.length === 0 ? (
        <p className="mt-6 text-sm text-gray-600">Your cart is empty.</p>
      ) : (
        <div className="mt-6">
          <CheckoutWizard cart={cart} />
        </div>
      )}
    </main>
  );
}
