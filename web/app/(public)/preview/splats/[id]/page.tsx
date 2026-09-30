/**
 * The /preview/splats/[id] page: a shared splat, viewable without signing in.
 *
 * This is the link an owner hands out. It shows the splat and COLMAP's point cloud in the 3D viewer, with the cameras
 * each photo was taken from, beside how long each pipeline step took and a grid of the photos' thumbnails. It renders
 * on the server straight from the database (web/lib/server/data.ts), and it 404s unless the splat is complete and its
 * owner has made it shareable. Its metadata gives link previews in chat apps a title and thumbnail, and keeps the page
 * out of search results unless it is one of the landing page's showcase examples.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PublicSplatView } from "@/components/splats/PublicSplatView";
import { getPublicSplat, getPublicSplatView } from "@/lib/server/data";
import { readSplatCameras } from "@/lib/server/s3";

/** Reads the database per request: a shared splat must not be frozen into a build artifact. */
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const splat = await getPublicSplat(id);
  if (splat === null) {
    return { title: "Not found" };
  }

  const description = `${splat.title}, a 3D Gaussian Splat trained on a CUDA GPU from photogrammetry of multi-angle photos. Turn it around in your browser.`;

  // openGraph replaces web/app/layout.tsx's openGraph whole rather than merging with it, so it repeats the description.
  return {
    title: splat.title,
    description,
    openGraph: {
      title: splat.title,
      description,
      images: [splat.thumbnailUrl],
    },
    twitter: { card: "summary_large_image" },
    // Owners treat a share link as unlisted, so search engines are asked to leave it out of their results. The
    // showcase examples are already public on the / landing page, and ranking them is the point.
    robots: { index: splat.isShowcase },
  };
}

export default async function PublicSplatViewPage({ params }: Props) {
  const { id } = await params;

  const splat = await getPublicSplatView(id);
  if (splat === null) {
    notFound();
  }

  const cameras = await readSplatCameras(id);

  return (
    <PublicSplatView
      title={splat.title}
      splatUrl={splat.splatUrl}
      pointCloudUrl={splat.pointCloudUrl}
      cameras={cameras}
      photos={splat.photos}
      timestamps={splat.timestamps}
    />
  );
}
