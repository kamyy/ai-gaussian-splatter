"use client";

import { cn } from "@/lib/cn";
import type { UploadItemStatus } from "@/lib/store";
import { useAppStore } from "@/lib/store";

const STATUS_COLOR: Record<UploadItemStatus, string> = {
  pending: "bg-primary",
  uploading: "bg-info",
  uploaded: "bg-success",
  failed: "bg-error",
};

export function UploadProgress() {
  const uploads = useAppStore(state => state.uploads);
  const items = Object.values(uploads);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      {items.map(item => (
        <div key={item.filename} className="flex flex-nowrap items-center justify-between gap-2">
          <p className="flex-1 truncate text-sm">{item.filename}</p>
          <div className="h-1 w-30 overflow-hidden rounded-full bg-divider">
            <div
              className={cn("h-full rounded-full transition-[width]", STATUS_COLOR[item.status])}
              style={{ width: `${item.progress}%` }}
            />
          </div>
          <div
            className={cn("flex h-6 w-6 items-center justify-center rounded-full text-xs", STATUS_COLOR[item.status])}
          >
            {item.status === "uploaded" ? "✓" : item.status === "failed" ? "✕" : "…"}
          </div>
        </div>
      ))}
    </div>
  );
}
