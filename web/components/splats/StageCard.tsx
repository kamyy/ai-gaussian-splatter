"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useState } from "react";
import { mutate } from "swr";

import { Button, buttonClassName } from "@/components/ui/Button";
import { apiFetch } from "@/lib/apiFetch";
import type { Stage } from "@/lib/splatStage";
import type { Job } from "@/lib/types";
import { useAppSnackbar } from "@/lib/useAppSnackbar";
import { DeleteSplatButton, StopJobButton } from "./SplatActions";

interface StageCardProps {
  splatId: string;
  stage: Stage;
  // Called once an action has changed the splat's job, so the page refetches it.
  onJobChanged: () => void;
}

// What the visitor can do, or is waiting on, at the current stage. The complete stage has no card of its own; the
// share panel takes its place.
export function StageCard({ splatId, stage, onJobChanged }: StageCardProps) {
  const { getToken } = useAuth();
  const { enqueueSnackbar } = useAppSnackbar();
  const [pending, setPending] = useState(false);

  async function post(path: "process" | "train", failure: string) {
    setPending(true);
    try {
      const token = await getToken();
      if (!token) {
        throw new Error("Not signed in");
      }
      await apiFetch<Job>(`/api/v1/splats/${splatId}/${path}`, "POST", token);
      onJobChanged();
      await mutate("splats");
    } catch (err) {
      enqueueSnackbar(err instanceof Error ? err.message : failure, { variant: "error" });
    } finally {
      setPending(false);
    }
  }

  const startProcessing = () => post("process", "Failed to start");
  const startTraining = () => post("train", "Failed to start building");

  switch (stage.kind) {
    case "no_photos":
      return (
        <StageShell title="This splat has no photos">
          <p>Photos can only be added when a splat is created, so start a new one to try again.</p>
          <Link href="/splats/new" className={buttonClassName("contained", "medium", "self-start")}>
            New splat
          </Link>
        </StageShell>
      );
    case "ready":
      return (
        <StageShell title="Ready to start">
          <p>The next step places the cameras: working out where each photo was taken from.</p>
          <Button variant="contained" onClick={startProcessing} loading={pending} className="self-start">
            Start
          </Button>
        </StageShell>
      );
    case "placing_cameras":
      return (
        <StageShell title="Placing the cameras">
          <p>
            A cloud GPU is working out where each photo was taken from. This takes a few minutes, and you can close this
            tab while it runs.
          </p>
          <WorkingBar label="Placing the cameras" />
          <div className="self-start">
            <StopJobButton splatId={splatId} onJobChanged={onJobChanged} />
          </div>
        </StageShell>
      );
    case "check":
      return (
        <StageShell title="Does the shape look right?">
          <p>
            This is a rough sketch of the shape. If the outline looks right, build the full 3D version. If it&apos;s a
            jumble, re-shoot with more overlap between photos.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="contained" onClick={startTraining} loading={pending}>
              Looks right, build it
            </Button>
            <DeleteSplatButton splatId={splatId} label="Discard" variant="outlined" />
          </div>
          <p className="text-xs">Building takes a while. You can close this tab and come back.</p>
        </StageShell>
      );
    case "building":
      return (
        <StageShell title="Building your 3D splat">
          <p>
            A cloud GPU is turning the sketch into a 3D splat. You can close this tab. It keeps going, and this page
            will be ready when you come back.
          </p>
          <WorkingBar label="Building the splat" />
          <div className="self-start">
            <StopJobButton splatId={splatId} onJobChanged={onJobChanged} />
          </div>
        </StageShell>
      );
    case "complete":
      return null;
    case "failed":
      return (
        <StageShell title="Something went wrong" tone="error">
          <p>{stage.message ?? "Processing stopped before it finished."}</p>
          {stage.step === "cameras" && (
            <p>
              If placing the cameras fails again, the photos probably need more overlap. Start a new splat and re-shoot.
            </p>
          )}
          <Button variant="contained" onClick={startProcessing} loading={pending} className="self-start">
            Try again
          </Button>
        </StageShell>
      );
    case "cancelled":
      return (
        <StageShell title="Cancelled">
          <p>Processing was stopped before it finished.</p>
          <Button variant="contained" onClick={startProcessing} loading={pending} className="self-start">
            Start again
          </Button>
        </StageShell>
      );
  }
}

function StageShell({
  title,
  tone = "default",
  children,
}: {
  title: string;
  tone?: "default" | "error";
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby="stage-heading"
      className="flex flex-col gap-3.5 rounded-3xl border border-divider bg-paper p-6 text-sm text-muted-foreground"
    >
      <h2
        id="stage-heading"
        className={tone === "error" ? "font-display text-3xl text-error" : "font-display text-3xl text-foreground"}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

// No stage reports how far along it is, so this only shows that something is running.
function WorkingBar({ label }: { label: string }) {
  return (
    <div role="progressbar" aria-label={label} className="h-2 overflow-hidden rounded-full bg-divider">
      <div className="h-full w-1/3 animate-working motion-reduce:animate-none rounded-full bg-primary" />
    </div>
  );
}
