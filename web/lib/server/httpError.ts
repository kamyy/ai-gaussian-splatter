import { NextResponse } from "next/server";

/**
 * Thrown from anywhere in a handler's call stack and turned into a response by
 * `withErrorHandling`, so services can reject from deep inside rather than
 * threading error tuples back up.
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
 * Guards a path parameter before it reaches the database.
 *
 * The id columns are `uuid`, so a malformed value makes Postgres raise
 * `22P02`, which surfaces as a 500. 404 rather than 422 because these are all
 * lookup-by-id routes that already collapse "not yours" into "not found" — an
 * unparseable id can't name a row, so it gets the same answer.
 */
export function requireUuid(value: string, status = 404, message = "Not found"): string {
  if (!UUID_PATTERN.test(value)) {
    throw new HttpError(status, message);
  }
  return value;
}

/** Error body shape: `{"detail": "..."}`. */
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
