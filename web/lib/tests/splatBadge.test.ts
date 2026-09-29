import { describe, expect, it } from "vitest";

import { splatBadge } from "../splatBadge";
import { JOB_STATUSES } from "../types";

describe("splatBadge", () => {
  it("shows a splat with no job as a dead end without photos, and ready to start with them", () => {
    expect(splatBadge({ photoCount: 0, latestJobStatus: null })).toMatchObject({ label: "No photos", filter: null });
    expect(splatBadge({ photoCount: 3, latestJobStatus: null })).toMatchObject({
      label: "Ready to start",
      color: "primary",
      filter: "needs_you",
    });
  });

  it("gives every job status a badge", () => {
    for (const status of JOB_STATUSES) {
      expect(splatBadge({ photoCount: 3, latestJobStatus: status })?.label).toBeTruthy();
    }
  });

  it("lists only the splats waiting on the visitor under needs_you", () => {
    const needsYou = JOB_STATUSES.filter(
      status => splatBadge({ photoCount: 3, latestJobStatus: status }).filter === "needs_you",
    );
    expect(needsYou.sort()).toEqual(["awaiting_training", "cancelled", "failed"]);
  });
});
