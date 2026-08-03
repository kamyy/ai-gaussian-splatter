import { NextResponse } from "next/server";

/**
 * Thrown from anywhere in a Route Handler's call stack and converted to a
 * response by `withErrorHandling` — the equivalent of FastAPI's HTTPException,
 * which the ported code (rateLimit.ts, auth.ts) relies on being able to raise
 * from deep inside a service rather than returning error tuples upward.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Guards a path parameter before it reaches Prisma.
 *
 * The id columns are `@db.Uuid`, so a malformed value makes Postgres raise
 * `22P02 invalid input syntax for type uuid`; Prisma surfaces that as a plain
 * error, which `withErrorHandling` rethrows as a 500. FastAPI never had this
 * problem — declaring `object_id: uuid.UUID` made it reject malformed ids with
 * a 422 before any handler ran.
 *
 * Throws the caller's status instead of 422 because these are all
 * lookup-by-id routes that already collapse "not yours" into "not found":
 * an unparseable id can't name an existing row, so it gets the same answer.
 */
export function requireUuid(value: string, status = 404, message = "Not found"): string {
  if (!UUID_PATTERN.test(value)) {
    throw new HttpError(status, message);
  }
  return value;
}

/**
 * Matches FastAPI's error body (`{"detail": "..."}`), which the former backend
 * returned for every HTTPException.
 */
export function errorResponse(status: number, detail: string): NextResponse {
  return NextResponse.json({ detail }, { status });
}

type Handler<Args extends unknown[]> = (...args: Args) => Promise<NextResponse>;

export function withErrorHandling<Args extends unknown[]>(handler: Handler<Args>): Handler<Args> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof HttpError) {
        return errorResponse(error.status, error.message);
      }
      throw error;
    }
  };
}
