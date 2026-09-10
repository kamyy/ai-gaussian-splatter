// Typed REST client for the Route Handlers in web/app/api/v1/. Authenticated endpoints take a Clerk session token,
// obtained client-side via useAuth().getToken() and passed in by callers (web/lib/hooks.ts).

export async function apiFetch<T>(
  path: string,
  method: "GET" | "POST" | "PUT",
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
