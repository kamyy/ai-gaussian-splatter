import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Stack, Text, Title } from "@mantine/core";

import { getGalleryItem } from "@/lib/api";
import { SplatViewer } from "@/components/viewer/SplatViewer";

// See app/gallery/page.tsx — same reasoning, fetches the backend at request
// time, not buildable statically without it running.
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  try {
    const item = await getGalleryItem(id);
    return {
      title: `${item.title} — AI Gaussian Splatter`,
      description: item.description ?? "A 3D Gaussian Splat reconstruction.",
      openGraph: {
        title: item.title,
        description: item.description ?? undefined,
        images: [item.thumbnail_url],
      },
    };
  } catch {
    return { title: "Not found — AI Gaussian Splatter" };
  }
}

export default async function GalleryItemPage({ params }: Props) {
  const { id } = await params;

  let item;
  try {
    item = await getGalleryItem(id);
  } catch {
    notFound();
  }

  return (
    <Stack p="md">
      <Title order={2}>{item.title}</Title>
      {item.description && <Text c="dimmed">{item.description}</Text>}
      <SplatViewer splatUrl={item.splat_url} />
    </Stack>
  );
}
