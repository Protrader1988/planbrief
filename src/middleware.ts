import { NextResponse, type NextRequest } from "next/server";

/**
 * Password gate. When APP_PASSWORD is set, every page and API route (except the login
 * page and the login API) requires the session cookie. Keeps the app private when it is
 * exposed to the internet for phone access.
 */
export function middleware(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (pathname === "/login" || pathname === "/api/login" || pathname.startsWith("/_next/") || pathname === "/favicon.ico") {
    return NextResponse.next();
  }
  const cookie = req.cookies.get("pb_session")?.value;
  if (cookie && cookie === sessionToken(password)) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

/** Deterministic token derived from the password (edge-safe, no crypto import needed). */
export function sessionToken(password: string) {
  let h = 2166136261;
  const s = "planbrief:" + password;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let h2 = 5381;
  for (let i = s.length - 1; i >= 0; i--) h2 = (Math.imul(h2, 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16) + h2.toString(16);
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
