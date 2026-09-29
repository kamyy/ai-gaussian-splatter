/**
 * GET /api/v1/healthz: the load balancer's health check.
 *
 * The AWS load balancer in front of the app calls this path to decide whether a container is healthy enough to receive
 * traffic. It answers without touching the database, so a healthy result means the Next.js server is up, not that
 * queries work. infra/web.tf pins the exact path, so it must not move.
 */

import { NextResponse } from "next/server";

export function GET(): NextResponse {
  return NextResponse.json({ status: "ok" });
}
