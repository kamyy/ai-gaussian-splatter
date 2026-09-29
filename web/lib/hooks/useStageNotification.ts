/**
 * Tells the visitor when a splat's running stage finishes, through the tab title and a browser notification.
 *
 * Each GPU stage takes minutes, so a visitor on a splat's page usually switches to another tab while it runs. The tab
 * title names the running stage. When a stage finishes while the tab is hidden, the title says so until the tab is
 * looked at again, and a system notification fires if the visitor allowed them. Both depend on the page's own polling
 * (web/lib/hooks/useLatestJob.ts), so they only work while the tab stays open.
 */

"use client";

import { useEffect, useRef, useState } from "react";

import type { Stage } from "@/lib/splatStage";

type StageKind = Stage["kind"];

// What a running stage finishing into each of these means to the visitor. Moving into any other stage is a cancel,
// which is the visitor's own doing and needs no notice.
const FINISHED: Partial<Record<StageKind, string>> = {
  check: "The shape is ready to check",
  complete: "Your 3D splat is ready",
  failed: "Processing failed",
};

function isRunning(kind: StageKind | undefined) {
  return kind === "placing_cameras" || kind === "building";
}

function runningLabel(stage: Stage): string | null {
  if (stage.kind === "placing_cameras") {
    return "Placing cameras";
  }

  if (stage.kind === "building") {
    return stage.progress === null ? "Building" : `Building ${stage.progress}%`;
  }

  return null;
}

/**
 * Pass undefined for both while the page is still loading. A notice fires only for a change this hook watched happen,
 * so opening the page on a splat that already finished announces nothing.
 */
export function useStageNotification(splatName: string | undefined, stage: Stage | undefined) {
  const previousKind = useRef<StageKind | undefined>(undefined);
  const kind = stage?.kind;

  // The finish the visitor hasn't seen yet, which the title shows until the tab is visible again.
  const [unseen, setUnseen] = useState<string | null>(null);
  const label = unseen ?? (stage === undefined ? null : runningLabel(stage));

  useEffect(() => {
    const previous = previousKind.current;
    previousKind.current = kind;
    const finished = kind === undefined ? undefined : FINISHED[kind];
    if (!isRunning(previous) || finished === undefined || !document.hidden) {
      return;
    }

    setUnseen(finished);
    if ("Notification" in window && Notification.permission === "granted") {
      // Chrome on Android throws "Illegal constructor" here, since it only shows notifications through a service
      // worker. The title above still tells that visitor.
      try {
        const notification = new Notification(finished, { body: splatName });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
      } catch {
        // Nothing else to try without a service worker.
      }
    }
  }, [kind, splatName]);

  useEffect(() => {
    if (unseen === null) {
      return;
    }

    const clearOnceSeen = () => {
      if (!document.hidden) {
        setUnseen(null);
      }
    };
    document.addEventListener("visibilitychange", clearOnceSeen);

    return () => document.removeEventListener("visibilitychange", clearOnceSeen);
  }, [unseen]);

  useEffect(() => {
    if (label === null || splatName === undefined) {
      return;
    }

    const original = document.title;
    document.title = `${label} · ${splatName}`;

    return () => {
      document.title = original;
    };
  }, [label, splatName]);
}
