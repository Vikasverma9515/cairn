import { NextResponse } from "next/server";
import { logout } from "../../../../../lib/shop";

export async function POST() {
  logout();
  return NextResponse.json({ loggedIn: false });
}
