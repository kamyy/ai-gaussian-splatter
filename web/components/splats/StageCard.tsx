/**
 * The card on a splat's page that says what happens next.
 *
 * Each stage of a splat (no photos, ready to process, placing the cameras, waiting for the visitor's check, building,
 * failed, cancelled) has its own heading, explanation and buttons, such as starting processing, building the splat, or
 * stopping a run. While the splat builds, it shows a progress bar with a time estimate. While processing is paused for
 * the whole site, every button that starts a run is disabled with a notice saying why.
 */

"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useSnackbar } from "notistack";
import { useState } from "react";
import { useSWRConfig } from "swr";

import { Button, buttonClassName } from "@/components/ui/Button";
import { apiFetch } from "@/lib/apiFetch";
import { useProcessingPaused } from "@/lib/hooks/useProcessingPaused";
import { requireToken } from "@/lib/requireToken";
import type { Stage } from "@/lib/splatStage";
import type { Job } from "@/lib/types";
import { ProcessingPausedNotice } from "./ProcessingPausedNotice";
import { DiscardSplatButton, StopJobButton } from "./SplatActions";
import { StageShell } from "./StageShell";

// Below this the elapsed time says too little about the rest of the run to project from.
const MIN_PERCENT_FOR_ESTIMATE = 5;

interface StageCardProps {
  splatId: string;
  stage: Stage;
  // Called once an action has changed the splat's job, so the page refetches it.
  onJobChanged: () => void;
}

// For a stage that doesn't report how far along it is: this only shows that something is running.
function WorkingBar({ label }: { label: string }) {
  return (
    <div role="progressbar" aria-label={label} className="h-2 overflow-hidden rounded-full bg-divider">
      <div className="h-full w-1/3 animate-working motion-reduce:animate-none rounded-full bg-primary" />
    </div>
  );
}

function timeLeft(percent: number, startedAt: string | null): string | null {
  if (startedAt === null || percent < MIN_PERCENT_FOR_ESTIMATE || percent >= 100) {
    return null;
  }

  const elapsedMs = Date.now() - new Date(startedAt).getTime();
  const minutes = Math.round((elapsedMs * (100 - percent)) / percent / 60_000);
  if (minutes < 1) {
    return "Less than a minute left";
  }

  return `About ${minutes} minute${minutes === 1 ? "" : "s"} left`;
}

function ProgressBar({ label, percent, startedAt }: { label: string; percent: number; startedAt: string | null }) {
  const estimate = timeLeft(percent, startedAt);
  return (
    <div className="flex flex-col gap-2">
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-2 overflow-hidden rounded-full bg-divider"
      >
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <div className="flex justify-between text-xs">
        <span>{percent}%</span>
        {estimate ? <span>{estimate}</span> : null}
      </div>
    </div>
  );
}

/**
 * What the visitor can do, or is waiting on, at the current stage. The complete stage has no card of its own. The
 * share panel (web/components/splats/SharePanel.tsx) takes its place in the same StageShell.
 */
export function StageCard({ splatId, stage, onJobChanged }: StageCardProps) {
  const { getToken } = useAuth();
  const { mutate } = useSWRConfig();
  const { enqueueSnackbar } = useSnackbar();
  const processingPaused = useProcessingPaused();
  const [pending, setPending] = useState(false);

  async function post(path: "process" | "train", failure: string) {
    setPending(true);
    try {
      await apiFetch<Job>(`/api/v1/splats/${splatId}/${path}`, "POST", await requireToken(getToken));
      onJobChanged();
      await mutate("splats");
    } catch (err) {
      enqueueSnackbar(failure, {
        variant: "error",
        detail: err instanceof Error ? err.message : undefined,
        persist: true,
      });

      // The failure may be processing having just been paused. Refetching now shows the notice and disables this button
      // straight away, rather than at the next minute's poll.
      await mutate("processing");
    } finally {
      setPending(false);
    }
  }

  const startProcessing = () => post("process", "Couldn't start processing");
  const startTraining = () => post("train", "Couldn't start building");
  const discardButton = <DiscardSplatButton splatId={splatId} variant="outlined" />;

  // The start and build buttons are disabled with it, so a paused site is explained rather than just unclickable.
  let pausedNotice: React.ReactNode = null;
  if (processingPaused) {
    pausedNotice = (
      <ProcessingPausedNotice>
        Processing is paused for the whole site. This splat can&apos;t go on until processing is turned back on.
      </ProcessingPausedNotice>
    );
  }

  switch (stage.kind) {
    case "no_photos":
      return (
        <StageShell title="This splat has no photos">
          <p>Photos can only be added when a splat is created, so start a new one to try again.</p>
          <div className="flex flex-wrap gap-2">
            <Link href="/splats/new" className={buttonClassName("contained", "medium")}>
              New splat
            </Link>
            {discardButton}
          </div>
        </StageShell>
      );
    case "ready":
      return (
        <StageShell title="Ready to start">
          <p>The next step places the cameras: working out where each photo was taken from.</p>
          {pausedNotice}
          <div className="flex flex-wrap gap-2">
            <Button variant="contained" onClick={startProcessing} loading={pending} disabled={processingPaused}>
              Start
            </Button>
            {discardButton}
          </div>
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
          <div className="flex flex-wrap gap-2">
            <StopJobButton splatId={splatId} onJobChanged={onJobChanged} />
            {discardButton}
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
          <p>Once it&apos;s built, you can crop away the background in the 3D view.</p>
          {pausedNotice}
          <div className="flex flex-wrap gap-2">
            <Button variant="contained" onClick={startTraining} loading={pending} disabled={processingPaused}>
              Looks right, build it
            </Button>
            {discardButton}
          </div>
          <p className="text-xs">Building takes a while. You can close this tab and come back.</p>
        </StageShell>
      );
    case "building": {
      let bar: React.ReactNode;
      if (stage.progress === null) {
        bar = <WorkingBar label="Building the splat" />;
      } else {
        bar = <ProgressBar label="Building the splat" percent={stage.progress} startedAt={stage.startedAt} />;
      }

      return (
        <StageShell title="Building your 3D splat">
          <p>
            A cloud GPU is turning the sketch into a 3D splat. You can close this tab. It keeps going, and this page
            will be ready when you come back.
          </p>
          {bar}
          <div className="flex flex-wrap gap-2">
            <StopJobButton splatId={splatId} onJobChanged={onJobChanged} />
            {discardButton}
          </div>
        </StageShell>
      );
    }
    case "complete":
      return null;
    case "failed": {
      let reshootHint: React.ReactNode = null;
      if (stage.step === "cameras") {
        reshootHint = (
          <p>
            If placing the cameras fails again, the photos probably need more overlap. Start a new splat and re-shoot.
          </p>
        );
      }

      return (
        <StageShell title="Something went wrong" tone="error">
          <p>{stage.message ?? "Processing stopped before it finished."}</p>
          {reshootHint}
          {pausedNotice}
          <div className="flex flex-wrap gap-2">
            <Button variant="contained" onClick={startProcessing} loading={pending} disabled={processingPaused}>
              Try again
            </Button>
            {discardButton}
          </div>
        </StageShell>
      );
    }
    case "cancelled":
      return (
        <StageShell title="Cancelled">
          <p>Processing was stopped before it finished.</p>
          {pausedNotice}
          <div className="flex flex-wrap gap-2">
            <Button variant="contained" onClick={startProcessing} loading={pending} disabled={processingPaused}>
              Start again
            </Button>
            {discardButton}
          </div>
        </StageShell>
      );
  }
}
