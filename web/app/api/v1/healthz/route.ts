import { NextResponse } from "next/server";

// Target of the ECS Express Mode health check — infra/stacks/backend_stack.py
// pins this exact path, so it must not move.
export function GET(): NextResponse {
  return NextResponse.json({ status: "ok" });
}
