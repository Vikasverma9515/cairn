import { NextResponse } from "next/server";
import { login } from "../../../../../lib/shop";

export async function POST() {
  login();
  return NextResponse.json({ loggedIn: true });
}
