/**
 * The share and download controls for a finished splat.
 *
 * Offers the public link to the splat, a copy button for it, and a download of the full splat file.
 */

"use client";

import { useAuth } from "@clerk/nextjs";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { apiFetch } from "@/lib/apiFetch";
import { useAppSnackbar } from "@/lib/hooks/useAppSnackbar";
import { requireToken } from "@/lib/requireToken";
import { StageShell } from "./StageShell";

/**
 * Shown once a splat is complete. The link is the public view (web/app/(public)/preview/splats/[id]/page.tsx), which
 * needs no sign-in. Children sit in a row beside the download button, and the page passes its Discard button, which
 * the prose above that row describes.
 */
export function SharePanel({ splatId, children }: { splatId: string; children?: React.ReactNode }) {
  const { getToken } = useAuth();
  const { enqueueSnackbar } = useAppSnackbar();

  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // The page renders this only after its client-side fetches resolve, never on the server, so window is defined.
  const shareUrl = `${window.location.origin}/preview/splats/${splatId}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      enqueueSnackbar("Couldn't copy the link", { variant: "error", detail: "Select it and copy it by hand." });
    }
  }

  async function download() {
    setDownloading(true);
    try {
      const token = await requireToken(getToken);
      window.location.assign(await apiFetch<string>(`/api/v1/splats/${splatId}/download`, "GET", token));
    } catch (err) {
      enqueueSnackbar("Download failed", { variant: "error", detail: err instanceof Error ? err.message : undefined });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <StageShell title="Your splat is ready">
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            aria-label="Public link"
            readOnly
            value={shareUrl}
            onFocus={event => event.currentTarget.select()}
            className="h-11 min-w-0 flex-1 rounded-full border border-outline bg-paper px-4 text-sm text-foreground"
          />
          <Button variant="contained" onClick={copy} aria-live="polite">
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p>Anyone with the link can view it. No sign-in needed.</p>
      </div>
      <p>
        Download the splat as a .ply file to open it in other 3D tools. Discarding it deletes the splat and its photos,
        and the public link stops working.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ink" onClick={download} loading={downloading}>
          Download .ply
        </Button>
        {children}
      </div>
    </StageShell>
  );
}
