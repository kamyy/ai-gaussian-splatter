/**
 * A warning that GPU processing is paused for the whole site.
 *
 * The new-splat form and the splat page's Start and Build cards show it while web/lib/hooks/useProcessingPaused.ts
 * reports processing as off. The caller supplies the sentence, since what the visitor can still do differs between the
 * two places.
 */

import { ProcessingPausedIcon } from "@/components/ui/icons";

export function ProcessingPausedNotice({ children }: { children: React.ReactNode }) {
  // The tint is mixed into the paper color, matching the warning snackbar (web/components/layout/AlertSnackbar.tsx).
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-xl border border-primary/30 bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--color-paper))] p-3.5 text-sm text-foreground"
    >
      <ProcessingPausedIcon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
      <p>{children}</p>
    </div>
  );
}
