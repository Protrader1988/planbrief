import { NextResponse } from "next/server";
import { sessionToken } from "@/middleware";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.json({ ok: true });
  const body = await req.json().catch(() => ({}));
  if (typeof body.password !== "string" || body.password !== password) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set("pb_session", sessionToken(password), {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 90,
  });
  return res;
}
