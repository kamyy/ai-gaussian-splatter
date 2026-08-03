// CardSection (standalone) rather than Card.Section — see the note in
// app/(dashboard)/layout.tsx about compound static properties not resolving
// through the bundler in this @mantine/core version.
import { Card, CardSection, Image, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import type { Metadata } from "next";
import Link from "next/link";

import { listGallery } from "@/lib/server/data";

// Reads the database at request time. Still force-dynamic, but no longer
// because a separate backend was unreachable during `next build` — now it's
// simply that gallery contents must not be frozen into a build artifact.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Gallery — AI Gaussian Splatter",
  description: "Example 3D reconstructions made with AI Gaussian Splatter.",
};

export default async function GalleryPage() {
  const items = await listGallery();

  return (
    <Stack p="md">
      <Title order={2}>Gallery</Title>
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
        {items.map(item => (
          // Nesting <Link> around <Card> rather than Card's polymorphic
          // `component={Link}` prop — the latter passes a raw function
          // reference across the Server->Client Component boundary (this
          // page is an async Server Component; Card is a Client Component
          // internally), which RSC serialization forbids.
          <Link key={item.id} href={`/gallery/${item.id}`} style={{ textDecoration: "none", color: "inherit" }}>
            <Card withBorder padding="lg">
              <CardSection>
                <Image src={item.thumbnailUrl} alt={item.title} height={180} />
              </CardSection>
              <Text fw={500} mt="sm">
                {item.title}
              </Text>
              {item.description && (
                <Text size="sm" c="dimmed">
                  {item.description}
                </Text>
              )}
            </Card>
          </Link>
        ))}
      </SimpleGrid>
    </Stack>
  );
}
