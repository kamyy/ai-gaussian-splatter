import { NextResponse } from "next/server";

// Target of the load balancer's health check — infra/stacks/web_stack.py
// pins this exact path, so it must not move.
export function GET(): NextResponse {
  return NextResponse.json({ status: "ok" });
}
