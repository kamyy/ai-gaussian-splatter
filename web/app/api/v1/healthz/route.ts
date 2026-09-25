import { NextResponse } from "next/server";

// The load balancer's health check calls this path. infra/web.tf pins the exact path, so it must not move.
export function GET(): NextResponse {
  return NextResponse.json({ status: "ok" });
}
