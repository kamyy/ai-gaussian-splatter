import { Stack, Title } from "@mantine/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SplatViewer } from "@/components/viewer/SplatViewer";
import { getPublicSplat } from "@/lib/server/data";

// See web/app/gallery/page.tsx — same reasoning.
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const splat = await getPublicSplat(id);
  if (splat === null) {
    return { title: "Not found — AI Gaussian Splatter" };
  }
  return {
    title: `${splat.title} — AI Gaussian Splatter`,
    description: "A 3D Gaussian Splat reconstruction, made with AI Gaussian Splatter.",
    openGraph: {
      title: splat.title,
      images: [splat.thumbnailUrl],
    },
  };
}

export default async function PublicSplatViewPage({ params }: Props) {
  const { id } = await params;

  const splat = await getPublicSplat(id);
  if (splat === null) {
    notFound();
  }

  return (
    <Stack p="md">
      <Title order={2}>{splat.title}</Title>
      <SplatViewer splatUrl={splat.splatUrl} />
    </Stack>
  );
}
