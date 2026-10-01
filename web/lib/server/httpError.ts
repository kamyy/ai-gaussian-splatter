/**
 * How Route Handlers report errors as HTTP responses.
 *
 * Code anywhere in a handler's call stack throws an HttpError with a status code, and withErrorHandling() wraps each
 * handler to turn it into a JSON error response. Anything else is rethrown, so Next.js logs it and answers with a 500.
 * requireUuid() checks an id from the URL before it reaches the database, and parseJsonBody() checks a request's body.
 */

import { NextResponse } from "next/server";
import type { ZodType } from "zod";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Handler<Args extends unknown[]> = (...args: Args) => Promise<NextResponse>;

/**
 * Thrown from anywhere in a handler's call stack and turned into a response by `withErrorHandling`, so services can
 * reject from deep inside rather than threading error tuples back up.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Guards a path parameter before it reaches the database.
 *
 * The id columns are `uuid`, so a malformed value makes Postgres raise `22P02`, which surfaces as a 500. 404 rather
 * than 422 because these are all lookup-by-id routes that already collapse "not yours" into "not found." An
 * unparseable id can't name a row, so it gets the same answer.
 */
export function requireUuid(value: string, status: number, message: string): void {
  if (!isUuid(value)) {
    throw new HttpError(status, message);
  }
}

/** The request's JSON body, checked against schema. A body that fails the schema or isn't JSON at all is a 422. */
export async function parseJsonBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw new HttpError(422, "Invalid request body");
  }

  return parsed.data;
}

/** Error body shape: `{"detail": "..."}`. */
function errorResponse(status: number, detail: string): NextResponse {
  return NextResponse.json({ detail }, { status });
}

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
