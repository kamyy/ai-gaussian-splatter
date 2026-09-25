import { cn } from "@/lib/cn";
import { currentStep, STEPS, type Stage } from "@/lib/splatStage";

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" fill="none" className={className} aria-hidden="true">
      <path d="M2.5 6.2l2.2 2.2 4.8-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// Vertical while there is a step in progress, collapsing to one compact row of checks once every step is done.
export function PipelineStepper({ stage }: { stage: Stage }) {
  const current = currentStep(stage);

  if (current === null) {
    return (
      <div className="flex items-center gap-1.5">
        <ol aria-label="Progress" className="flex items-center gap-1.5">
          {STEPS.map((step, index) => (
            <li key={step.key} className="flex items-center gap-1.5">
              <span
                title={step.label}
                className="flex h-4.5 w-4.5 items-center justify-center rounded-full bg-primary text-primary-foreground"
              >
                <CheckIcon className="h-2.5 w-2.5" />
                <span className="sr-only">{step.label}: done</span>
              </span>
              {index < STEPS.length - 1 ? <span className="h-0.5 w-4.5 bg-primary" /> : null}
            </li>
          ))}
        </ol>
        <span className="ml-2 text-sm font-semibold text-primary">Ready to share</span>
      </div>
    );
  }

  const currentIndex = STEPS.findIndex(step => step.key === current);
  const failed = stage.kind === "failed" || stage.kind === "cancelled";

  return (
    <ol aria-label="Progress" className="flex flex-col">
      {STEPS.map((step, index) => {
        const done = index < currentIndex;
        const isCurrent = index === currentIndex;
        let connector: React.ReactNode = null;
        if (index < STEPS.length - 1) {
          connector = <span className={cn("min-h-2.5 w-0.5 flex-1", done ? "bg-primary" : "bg-divider")} />;
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
                {done ? <CheckIcon className="h-3 w-3" /> : null}
                {isCurrent ? <span className={cn("h-2 w-2 rounded-full", failed ? "bg-error" : "bg-primary")} /> : null}
              </span>
              {connector}
            </div>
            <span
              className={cn(
                "pb-2 text-sm",
                isCurrent ? "font-bold" : "font-medium",
                !done && !isCurrent && "text-muted-foreground",
              )}
            >
              {step.label}
              {done ? <span className="sr-only">: done</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
