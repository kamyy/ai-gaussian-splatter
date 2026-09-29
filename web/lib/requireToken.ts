/**
 * Gets the Clerk session token an authenticated API call needs, or throws.
 *
 * A signed-out session has no token. Throwing, rather than returning an empty result, is what puts an SWR hook into its
 * error state instead of showing a signed-in user with no data.
 */

export async function requireToken(getToken: () => Promise<string | null>): Promise<string> {
  const token = await getToken();
  if (!token) {
    throw new Error("Not signed in");
  }
  return token;
}
