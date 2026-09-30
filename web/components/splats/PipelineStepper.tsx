/**
 * The list of pipeline steps on a splat's page, with how far along the splat is.
 *
 * Shows each step from upload to a finished splat, marking the ones done and the one running. The two GPU steps also
 * show how long they took, counting up live while they run.
 */

"use client";

import { StepDoneIcon } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { useNow } from "@/lib/hooks/useNow";
import { currentStep, STEPS, type Stage, type StepKey } from "@/lib/splatStage";
import {
  formatClock,
  formatDuration,
  type StageTimings,
  type StepTiming,
  stageTimings,
  type TimedJob,
} from "@/lib/stageTimings";

// Who is reading the stepper: the splat's owner on their own page, or a visitor on the share page.
type Audience = "owner" | "visitor";

// What a step shows beside its label (a duration, or a count) and on a line under it.
interface StepExtras {
  aside: string | null;
  running: boolean;
  detail: string | null;
}

const NO_EXTRAS: StepExtras = { aside: null, running: false, detail: null };

function timingExtras(timing: StepTiming | null, workLabel: string): StepExtras {
  if (timing === null) {
    return NO_EXTRAS;
  }

  let detail: string | null = null;
  if (timing.bootMs !== null && timing.pullMs !== null && timing.workMs !== null) {
    detail = `Boot ${formatDuration(timing.bootMs)} · image pull ${formatDuration(timing.pullMs)} · ${workLabel} ${formatDuration(timing.workMs)}`;
  } else if (timing.startupMs !== null && timing.workMs !== null) {
    detail = `GPU start-up ${formatDuration(timing.startupMs)} · ${workLabel} ${formatDuration(timing.workMs)}`;
  } else if (timing.running) {
    detail = "Starting a GPU";
  }

  if (timing.running) {
    return { aside: `${formatClock(timing.totalMs)} so far`, running: true, detail };
  }

  return { aside: formatDuration(timing.totalMs), running: false, detail };
}

function stepExtras(key: StepKey, timings: StageTimings | null, photoCount: number, audience: Audience): StepExtras {
  switch (key) {
    case "upload":
      if (photoCount === 0) {
        return NO_EXTRAS;
      }
      return { ...NO_EXTRAS, aside: `${photoCount} photo${photoCount === 1 ? "" : "s"}` };
    case "cameras":
      return timingExtras(timings?.cameras ?? null, "reconstructing");
    case "check":
      if (timings?.checkMs == null) {
        return NO_EXTRAS;
      }
      return {
        ...NO_EXTRAS,
        aside: audience === "owner" ? `You took ${formatDuration(timings.checkMs)}` : formatDuration(timings.checkMs),
      };
    case "build":
      return timingExtras(timings?.build ?? null, "training");
    case "share":
      return NO_EXTRAS;
  }
}

// The camera and build stages' combined time, under the stepper once the splat is complete.
function gpuTotal(timings: StageTimings | null): string | null {
  if (!timings?.cameras || !timings.build) {
    return null;
  }

  return `${formatDuration(timings.cameras.totalMs + timings.build.totalMs)} of GPU time`;
}

/**
 * Each GPU step shows how long it took, split into the instance's start-up and the work itself. Once the splat is
 * complete, every step shows as done, and the list stays vertical so those times stay visible. A visitor on the share
 * page gets no Share step, since they are already looking at the shared splat.
 */
export function PipelineStepper({
  stage,
  job,
  photoCount,
  audience = "owner",
}: {
  stage: Stage;
  job: TimedJob | undefined;
  photoCount: number;
  audience?: Audience;
}) {
  const ticking = stage.kind === "placing_cameras" || stage.kind === "building";
  const now = useNow(ticking);
  const timings = job ? stageTimings(job, now) : null;

  const steps = audience === "owner" ? STEPS : STEPS.filter(step => step.key !== "share");
  const current = currentStep(stage);
  const complete = current === null;
  const currentIndex = complete ? steps.length : steps.findIndex(step => step.key === current);
  const failed = stage.kind === "failed" || stage.kind === "cancelled";

  let total: React.ReactNode = null;
  const gpuTime = complete ? gpuTotal(timings) : null;
  if (gpuTime !== null) {
    total = <p className="pl-8.5 text-sm text-muted-foreground tabular-nums">{gpuTime}</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      <ol aria-label="Progress" className="flex flex-col">
        {steps.map((step, index) => {
          const done = index < currentIndex;
          const isCurrent = index === currentIndex;
          const extras = done || isCurrent ? stepExtras(step.key, timings, photoCount, audience) : NO_EXTRAS;
          let connector: React.ReactNode = null;
          if (index < steps.length - 1) {
            connector = <span className={cn("min-h-2.5 w-0.5 flex-1", done ? "bg-primary" : "bg-divider")} />;
          }

          let aside: React.ReactNode = null;
          if (extras.aside !== null) {
            aside = (
              <span
                className={cn("tabular-nums", extras.running ? "text-primary" : "font-medium text-muted-foreground")}
              >
                {extras.aside}
              </span>
            );
          }

          let detail: React.ReactNode = null;
          if (extras.detail !== null) {
            detail = <span className="text-xs font-normal text-muted-foreground tabular-nums">{extras.detail}</span>;
          }

          return (
            <li key={step.key} aria-current={isCurrent ? "step" : undefined} className="flex min-h-8 gap-3">
              <div className="flex w-5.5 flex-col items-center">
                <span
                  className={cn(
                    "flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full border-2",
                    done && "border-primary bg-primary text-primary-foreground",
                    isCurrent && (failed ? "border-error" : "border-primary"),
                    !done && !isCurrent && "border-divider",
                  )}
                >
                  {done ? <StepDoneIcon aria-hidden="true" strokeWidth={3} className="h-3 w-3" /> : null}
                  {isCurrent ? (
                    <span className={cn("h-2 w-2 rounded-full", failed ? "bg-error" : "bg-primary")} />
                  ) : null}
                </span>
                {connector}
              </div>
              <div
                className={cn(
                  "flex min-w-0 flex-1 flex-col gap-0.5 pb-2 text-sm",
                  isCurrent ? "font-bold" : "font-medium",
                  !done && !isCurrent && "text-muted-foreground",
                )}
              >
                <div className="flex justify-between gap-3">
                  <span>
                    {step.label}
                    {done ? <span className="sr-only">: done</span> : null}
                  </span>
                  {aside}
                </div>
                {detail}
              </div>
            </li>
          );
        })}
      </ol>
      {total}
    </div>
  );
}
