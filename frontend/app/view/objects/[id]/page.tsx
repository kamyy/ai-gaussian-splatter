import { Stack, Title } from "@mantine/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SplatViewer } from "@/components/viewer/SplatViewer";
import { getPublicObject } from "@/lib/api";

// See app/gallery/page.tsx — same reasoning, fetches the backend at request
// time, not buildable statically without it running.
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  try {
    const object = await getPublicObject(id);
    return {
      title: `${object.title} — AI Gaussian Splatter`,
      description: "A 3D Gaussian Splat reconstruction, made with AI Gaussian Splatter.",
      openGraph: {
        title: object.title,
        images: [object.thumbnail_url],
      },
    };
  } catch {
    return { title: "Not found — AI Gaussian Splatter" };
  }
}

export default async function PublicObjectViewPage({ params }: Props) {
  const { id } = await params;

  let object;
  try {
    object = await getPublicObject(id);
  } catch {
    notFound();
  }

  return (
    <Stack p="md">
      <Title order={2}>{object.title}</Title>
      <SplatViewer splatUrl={object.splat_url} />
    </Stack>
  );
}
