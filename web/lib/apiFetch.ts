/**
 * The browser's typed client for the app's own REST API.
 *
 * Every call from the browser to the Route Handlers in web/app/api/v1/ goes through apiFetch(). It sends JSON, attaches
 * the Clerk session token for authenticated endpoints, and turns an error response into a thrown Error whose message is
 * the server's explanation, ready to show a user. Callers get the token with Clerk's useAuth().getToken() and pass it
 * in, as the SWR hooks in web/lib/hooks/ do.
 */

// The API's error body is `{"detail": "..."}` (web/lib/server/httpError.ts), and only the sentence is fit to show a
// user. A body in any other shape, such as a proxy's HTML error page, is passed through as it is.
function errorDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "detail" in parsed && typeof parsed.detail === "string") {
      return parsed.detail;
    }
  } catch {
    // Not JSON.
  }

  return body;
}

export async function apiFetch<T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  token?: string,
  body?: unknown,
): Promise<T> {
  const headers: [string, string][] = [["Content-Type", "application/json"]];

  if (token) {
    headers.push(["Authorization", `Bearer ${token}`]);
  }

  const resp =
    body === undefined
      ? await fetch(path, { headers, method })
      : await fetch(path, { headers, method, body: JSON.stringify(body) });

  if (resp.ok) {
    if (resp.status === 204) {
      return undefined as T; // 204 No Content: response has no body, so no json to parse.
    }

    return resp.json();
  }

  const txt = await resp.text().catch(() => "");
  throw new Error(errorDetail(txt) || resp.statusText);
}
