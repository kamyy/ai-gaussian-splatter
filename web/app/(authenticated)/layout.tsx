import { auth } from "@clerk/nextjs/server";

// Sign-in gate only — the shell and header live in the root layout. Next preserves layouts across sibling navigation,
// so this doesn't re-run on /dashboard → /splats/new; fine only while no page here server-renders protected data. See
// AGENTS.md.
export default async function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  await auth.protect();

  return children;
}
