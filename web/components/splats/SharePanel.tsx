"use client";

import { useAuth } from "@clerk/nextjs";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { apiFetch } from "@/lib/apiFetch";
import { useAppSnackbar } from "@/lib/useAppSnackbar";

// Shown once a splat is complete. The link is the public view (web/app/(public)/preview/splats/[id]/page.tsx), which
// needs no sign-in.
export function SharePanel({ splatId }: { splatId: string }) {
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
      enqueueSnackbar("Couldn't copy the link. Select it and copy it by hand.", { variant: "error" });
    }
  }

  async function download() {
    setDownloading(true);
    try {
      const token = await getToken();
      if (!token) {
        throw new Error("Not signed in");
      }
      window.location.assign(await apiFetch<string>(`/api/v1/splats/${splatId}/download`, "GET", token));
    } catch (err) {
      enqueueSnackbar(err instanceof Error ? err.message : "Download failed", { variant: "error" });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <section aria-labelledby="share-heading" className="flex flex-col gap-2.5">
      <h2 id="share-heading" className="text-sm font-semibold">
        <label htmlFor="share-link">Public link</label>
      </h2>
      <div className="flex gap-2">
        <input
          id="share-link"
          readOnly
          value={shareUrl}
          onFocus={event => event.currentTarget.select()}
          className="h-11 min-w-0 flex-1 rounded-full border border-divider bg-paper px-4 text-sm"
        />
        <Button variant="contained" onClick={copy} aria-live="polite">
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Anyone with the link can view it. No sign-in needed.</p>
      <Button variant="outlined" onClick={download} loading={downloading} className="mt-2 self-start">
        Download .ply
      </Button>
    </section>
  );
}
