import { Show, UserButton } from "@clerk/nextjs";
// AppShellHeader (standalone) rather than AppShell.Header — see the note in AGENTS.md about compound static properties
// not resolving through the bundler in this @mantine/core version.
import { AppShellHeader, Button, Group, Title } from "@mantine/core";
import Link from "next/link";

const plainLink = { textDecoration: "none", color: "inherit" };

// Rendered on every page, public and authenticated alike: without it a signed-out visitor has no way to reach sign-in,
// since the only entry point would be typing a protected URL and being bounced by Clerk.
//
// <Show> resolves the session on the client, so the header stays correct without this component reading auth() itself.
// It renders nothing at all while auth is still loading — neither branch, not the fallback.
export function SiteHeader() {
  return (
    <AppShellHeader>
      <Group h="100%" px="md" justify="space-between">
        <Title order={4}>
          <Link href="/" style={plainLink}>
            AI Gaussian Splatter
          </Link>
        </Title>

        <Group gap="sm">
          <Link href="/gallery" style={plainLink}>
            Gallery
          </Link>

          <Show
            when="signed-in"
            fallback={
              <Link href="/sign-in">
                <Button size="sm">Sign in</Button>
              </Link>
            }
          >
            <Link href="/dashboard">
              <Button size="sm" variant="default">
                Dashboard
              </Button>
            </Link>
            <UserButton />
          </Show>
        </Group>
      </Group>
    </AppShellHeader>
  );
}
