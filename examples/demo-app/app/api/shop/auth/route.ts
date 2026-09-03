import { NextResponse } from "next/server";
import { isLoggedIn } from "../../../../lib/shop";

// The auth-gate primitive's observePath — real login state, not a guess
// from page content.
export async function GET() {
  return NextResponse.json({ loggedIn: isLoggedIn() });
}
