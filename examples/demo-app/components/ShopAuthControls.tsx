"use client";

// The "auth-gate" primitive's real UI — a real logged-in/out toggle that
// checkout's own API route genuinely enforces server-side (see
// api/shop/checkout/route.ts's 403), not just a UI-only appearance.
export function ShopAuthControls({ loggedIn }: { loggedIn: boolean }) {
  async function toggle() {
    await fetch(`/api/shop/auth/${loggedIn ? "logout" : "login"}`, { method: "POST" });
    window.location.reload();
  }

  return (
    <button
      data-ai={loggedIn ? "shop-logout" : "shop-login"}
      onClick={toggle}
      className={
        loggedIn
          ? "rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100"
          : "rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800"
      }
    >
      {loggedIn ? "Log out" : "Log in"}
    </button>
  );
}
