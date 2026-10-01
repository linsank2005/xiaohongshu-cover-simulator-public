import { NextRequest, NextResponse } from "next/server";
import { checkLocalRequest } from "./lib/api-boundary";
export function middleware(request: NextRequest) {
  return checkLocalRequest(request) ?? NextResponse.next();
}
export const config = { matcher: "/api/:path*" };
