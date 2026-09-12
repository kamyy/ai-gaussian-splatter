import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SplatViewer } from "@/components/viewer/SplatViewer";
import { getPublicSplat } from "@/lib/server/data";

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

  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <Typography variant="h2" component="h2">
        {splat.title}
      </Typography>
      <SplatViewer mode="splat" splatUrl={splat.splatUrl} pointCloudUrl={null} />
    </Stack>
  );
}
