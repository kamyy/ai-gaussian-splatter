/**
 * The body of the public share page: the 3D viewer beside the pipeline's step times and the splat's photos.
 *
 * The share page (web/app/(public)/preview/splats/[id]/page.tsx) renders on the server and passes in presigned links
 * for everything shown here. Like the owner's page, the view opens on the first placed photo's camera, and picking
 * another photo flies the view to where it was taken. Nothing here can change the splat, so the viewer offers no crop
 * controls. It still shows the owner's crop, when there is one: web/lib/server/data.ts hands it the cropped file and
 * the box, and the point cloud view hides the points outside that box.
 */

"use client";

import { useState } from "react";

import { PageTitle } from "@/components/layout/PageTitle";
import { usePhotoSelection } from "@/lib/hooks/usePhotoSelection";
import { JobStatus } from "@/lib/statuses";
import type { CameraPose, CropBox, JobTimestamps, PublicPhoto } from "@/lib/types";
import { PhotoGrid } from "./PhotoGrid";
import { PipelineStepper } from "./PipelineStepper";
import { SplatViewerPanel } from "./SplatViewerPanel";
import { StageShell } from "./StageShell";

interface PublicSplatViewProps {
  title: string;
  splatUrl: string;
  pointCloudUrl: string | null;
  cropBox: CropBox | null;
  // Null when cameras.json is missing.
  cameras: CameraPose[] | null;
  photos: PublicPhoto[];
  timestamps: JobTimestamps;
}

export function PublicSplatView({
  title,
  splatUrl,
  pointCloudUrl,
  cropBox,
  cameras,
  photos,
  timestamps,
}: PublicSplatViewProps) {
  const { selection, selectPhoto, clearSelection } = usePhotoSelection(photos, cameras);

  const [hoveredPhotoId, setHoveredPhotoId] = useState<string | null>(null);

  const placedPhotoIds = cameras ? new Set(cameras.map(camera => camera.photoId)) : null;

  let photoGrid: React.ReactNode = null;
  if (photos.length > 0) {
    photoGrid = (
      <PhotoGrid
        photos={photos}
        placedPhotoIds={placedPhotoIds}
        selection={selection}
        onSelect={selectPhoto}
        hoveredPhotoId={hoveredPhotoId}
        onHover={setHoveredPhotoId}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:gap-10">
      <div className="flex flex-col gap-6 lg:w-120 lg:shrink-0">
        <PageTitle backHref="/" backLabel="Back to Home">
          {title}
        </PageTitle>
        <StageShell title="How it was made">
          {/* StageShell mutes its text for prose. The stepper's finished steps take the page's own text color. */}
          <div className="text-foreground">
            {/* The share page only serves a complete splat, so the worker job is complete and its point cloud key is
            unread. */}
            <PipelineStepper
              stage={{ kind: "complete" }}
              job={{ ...timestamps, status: JobStatus.complete, pointCloudS3Key: null }}
              photoCount={photos.length}
              audience="visitor"
            />
          </div>
        </StageShell>
        {photoGrid}
      </div>
      {/* min-w-0 lets the viewer shrink with the window, as on web/app/(authenticated)/splats/[id]/page.tsx. */}
      <section aria-label="3D view" className="h-120 min-w-0 lg:h-[75vh] lg:flex-1">
        <SplatViewerPanel
          splat={{ available: true, url: splatUrl }}
          pointCloud={{ available: pointCloudUrl !== null, url: pointCloudUrl ?? undefined }}
          cameras={cameras}
          cropBox={cropBox}
          selection={selection}
          onClearSelection={clearSelection}
        />
      </section>
    </div>
  );
}
