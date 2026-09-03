"use client";

export function AddToCartButton({ productId }: { productId: string }) {
  async function handleAdd() {
    await fetch("/api/shop/cart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productId, quantity: 1 }),
    });
    window.location.reload();
  }

  return (
    <button
      data-ai={`shop-add-to-cart-${productId}`}
      onClick={handleAdd}
      className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800"
    >
      Add to cart
    </button>
  );
}
