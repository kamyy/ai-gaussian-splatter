// The Clerk session token for an authenticated call. A signed-out session has none, which is reported as an error.
export async function requireToken(getToken: () => Promise<string | null>): Promise<string> {
  const token = await getToken();
  if (!token) {
    throw new Error("Not signed in");
  }
  return token;
}
