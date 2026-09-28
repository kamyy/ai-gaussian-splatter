import { useId } from "react";

import { cn } from "@/lib/cn";

// The card every stage of the splat page sits in, headed by what the visitor can do or is waiting on.
export function StageShell({
  title,
  tone = "default",
  children,
}: {
  title: string;
  tone?: "default" | "error";
  children: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3.5 rounded-3xl border border-divider bg-paper p-6 text-sm text-muted-foreground"
    >
      <h2 id={headingId} className={cn("font-display text-3xl", tone === "error" ? "text-error" : "text-foreground")}>
        {title}
      </h2>
      {children}
    </section>
  );
}
