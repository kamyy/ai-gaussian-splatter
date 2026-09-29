/**
 * The browser's typed client for the app's own REST API.
 *
 * Every call from the browser to the Route Handlers in web/app/api/v1/ goes through apiFetch(). It sends JSON, attaches
 * the Clerk session token for authenticated endpoints, and turns an error response into a thrown Error carrying the
 * response body as its message. Callers get the token with Clerk's useAuth().getToken() and pass it in, as the SWR
 * hooks in web/lib/hooks/ do.
 */

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
  throw new Error(txt || resp.statusText);
}
