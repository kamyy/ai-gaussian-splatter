import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SplatViewer } from "@/components/viewer/SplatViewer";
import { getPublicSplat } from "@/lib/server/data";
import { readSplatCameras } from "@/lib/server/s3";

// Reads the database per request: a shared splat must not be frozen into a build artifact.
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
  // Only the poses frame the view, so the photo ids stay off this public page.
  const cameras = (await readSplatCameras(id))?.map(({ photoId: _photoId, ...pose }) => pose) ?? null;

  return (
    <div className="flex flex-col gap-4 p-4">
      <h2 className="font-display text-6xl">{splat.title}</h2>
      <SplatViewer mode="splat" splatUrl={splat.splatUrl} pointCloudUrl={null} cameras={cameras} />
    </div>
  );
}
