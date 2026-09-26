import { LuLoaderCircle } from "react-icons/lu";

import { cn } from "@/lib/cn";

export function Spinner({ className }: { className?: string }) {
  return <LuLoaderCircle aria-hidden="true" className={cn("animate-spin", className)} />;
}
