import { UserButton } from "@clerk/nextjs";
// AppShell.Header/.Main (compound static properties) fail to resolve
// through Next's bundler in this @mantine/core version — reproducibly, under
// both Turbopack and Webpack, even though they work fine via plain Node
// `require()`. Using the standalone named exports instead, which Mantine
// ships for exactly this kind of bundler interop case.
import { AppShell, AppShellHeader, AppShellMain, Group, Title } from "@mantine/core";
import Link from "next/link";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
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
