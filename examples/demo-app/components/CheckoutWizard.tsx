"use client";

import { useState } from "react";
import type { CartLine } from "../lib/shop-types";
import { formatCents } from "../lib/shop-types";

// The "wizard" primitive's real UI — a real multi-step flow (review ->
// shipping -> confirm), each step's "Next" gated on that step's own real
// validation, ending in a real POST that creates a real order.
export function CheckoutWizard({ cart }: { cart: CartLine[] }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [placing, setPlacing] = useState(false);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const total = cart.reduce((sum, line) => sum + line.priceCents * line.quantity, 0);

  async function handlePlaceOrder() {
    setPlacing(true);
    setError(null);
    const res = await fetch("/api/shop/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, address }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Checkout failed");
      setPlacing(false);
      return;
    }
    const order = await res.json();
    setOrderId(order.id);
    setPlacing(false);
  }

  if (orderId) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-sm text-emerald-800" data-ai="shop-order-confirmation">
        Order placed — <span className="font-mono">{orderId}</span>.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm" data-ai="shop-checkout-wizard">
      <div className="mb-4 flex gap-2 text-xs font-medium text-gray-400">
        <span className={step === 1 ? "text-gray-900" : ""}>1. Review</span>
        <span>›</span>
        <span className={step === 2 ? "text-gray-900" : ""}>2. Shipping</span>
        <span>›</span>
        <span className={step === 3 ? "text-gray-900" : ""}>3. Confirm</span>
      </div>

      {step === 1 && (
        <div>
          <ul className="divide-y divide-gray-100">
            {cart.map((line) => (
              <li key={line.productId} className="flex justify-between py-2 text-sm text-gray-700">
                <span>
                  {line.name} × {line.quantity}
                </span>
                <span>{formatCents(line.priceCents * line.quantity)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-between text-sm font-semibold text-gray-900">
            <span>Total</span>
            <span>{formatCents(total)}</span>
          </div>
          <button
            data-ai="shop-wizard-next"
            onClick={() => setStep(2)}
            disabled={cart.length === 0}
            className="mt-4 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}

      {step === 2 && (
        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-gray-500">Email</label>
          <input
            data-ai="shop-wizard-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900"
          />
          <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-gray-500">Shipping address</label>
          <input
            data-ai="shop-wizard-address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900"
          />
          <div className="mt-4 flex gap-2">
            <button data-ai="shop-wizard-back" onClick={() => setStep(1)} className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100">
              Back
            </button>
            <button
              data-ai="shop-wizard-next"
              onClick={() => setStep(3)}
              disabled={!email || !address}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          <p className="text-sm text-gray-700">
            Ship to <span className="font-medium">{address}</span>, confirm at <span className="font-medium">{email}</span>. Total{" "}
            {formatCents(total)}.
          </p>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          <div className="mt-4 flex gap-2">
            <button data-ai="shop-wizard-back" onClick={() => setStep(2)} className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100">
              Back
            </button>
            <button
              data-ai="shop-wizard-place-order"
              onClick={handlePlaceOrder}
              disabled={placing}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60"
            >
              {placing ? "Placing…" : "Place order"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
