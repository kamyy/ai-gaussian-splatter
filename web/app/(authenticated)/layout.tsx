import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
// AppShell.Header/.Main (compound static properties) fail to resolve
// through Next's bundler in this @mantine/core version — reproducibly, under
// both Turbopack and Webpack, even though they work fine via plain Node
// `require()`. Using the standalone named exports instead, which Mantine
// ships for exactly this kind of bundler interop case.
import { AppShell, AppShellHeader, AppShellMain, Group, Title } from "@mantine/core";
import Link from "next/link";

// The sign-in gate for this route group — the only Server Component here, as
// all three pages under it are client components. It redirects a signed-out
// visitor instead of letting the shell render and fire 401s.
//
// Next preserves layouts across client-side navigation between sibling routes,
// so this does not re-run on /dashboard → /objects/new. That's sufficient only
// because it isn't the security boundary: no page here server-renders
// protected data, and every /api/v1 handler calls requireUser() itself. A page
// that starts reading protected data server-side needs its own auth.protect().
export default async function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  await auth.protect();

  return (
    <AppShell header={{ height: 60 }} padding="md">
      <AppShellHeader>
        <Group h="100%" px="md" justify="space-between">
          <Title order={4}>
            <Link href="/dashboard" style={{ textDecoration: "none", color: "inherit" }}>
              AI Gaussian Splatter
            </Link>
          </Title>
          <UserButton />
        </Group>
      </AppShellHeader>
      <AppShellMain>{children}</AppShellMain>
    </AppShell>
  );
}
