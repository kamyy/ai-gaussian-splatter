import { Stack, Title } from "@mantine/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SplatViewer } from "@/components/viewer/SplatViewer";
import { getPublicSplat } from "@/lib/server/data";

// See app/gallery/page.tsx — same reasoning.
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const object = await getPublicSplat(id);
  if (object === null) {
    return { title: "Not found — AI Gaussian Splatter" };
  }
  return {
    title: `${object.title} — AI Gaussian Splatter`,
    description: "A 3D Gaussian Splat reconstruction, made with AI Gaussian Splatter.",
    openGraph: {
      title: object.title,
      images: [object.thumbnailUrl],
    },
  };
}

export default async function PublicObjectViewPage({ params }: Props) {
  const { id } = await params;

  const object = await getPublicSplat(id);
  if (object === null) {
    notFound();
  }

  return (
    <Stack p="md">
      <Title order={2}>{object.title}</Title>
      <SplatViewer splatUrl={object.splatUrl} />
    </Stack>
  );
}
