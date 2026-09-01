import { and, count, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { jobs, photos, splats } from "@/lib/server/db/schema";
import { generateCallbackToken, launchJob, launchJobLocal } from "@/lib/server/ec2Launcher";
import { getEnv } from "@/lib/server/env";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { checkAndIncrementGlobalDaily } from "@/lib/server/rateLimit";
import { jobReadColumns } from "@/lib/server/selects";

// Populated from the ECR repo CDK stack output once infra is deployed. Placeholders for local/pre-deploy development.
function workerImageUri(): string {
  return process.env.WORKER_IMAGE_URI ?? "REPLACE_WITH_ECR_IMAGE_URI";
}

function ecrRegistry(): string {
  return process.env.ECR_REGISTRY ?? "REPLACE_WITH_ECR_REGISTRY";
}

// Runs the worker against the caller's own GPU via Podman instead of launching a real EC2 spot instance. See
// launchJobLocal() in web/lib/server/ec2Launcher.ts and "Triggering the worker from pnpm dev" in RUNBOOK.md.
function localLaunchEnabled(): boolean {
  return process.env.WORKER_LOCAL_LAUNCH === "true";
}

export const POST = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/process">) => {
    const env = getEnv();
    const user = await requireUser();
    const { splatId } = await ctx.params;
    requireUuid(splatId, 404, "Splat not found");

    const [splat] = await getDb()
      .select()
      .from(splats)
      .where(and(eq(splats.id, splatId), eq(splats.userId, user.id)))
      .limit(1);
    if (splat === undefined) {
      throw new HttpError(404, "Splat not found");
    }

    const [uploaded] = await getDb()
      .select({ n: count() })
      .from(photos)
      .where(and(eq(photos.splatId, splatId), eq(photos.uploadStatus, "uploaded")));
    if (uploaded.n < env.MIN_PHOTOS_PER_SPLAT) {
      throw new HttpError(400, `Need at least ${env.MIN_PHOTOS_PER_SPLAT} uploaded photos, have ${uploaded.n}`);
    }

    // The hard backstop, checked last so per-user/IP limits already screened most abuse before this expensive step is
    // even considered.
    await checkAndIncrementGlobalDaily(env.GLOBAL_MAX_JOBS_PER_DAY);

    const callbackToken = generateCallbackToken();
    const [created] = await getDb()
      .insert(jobs)
      .values({ splatId, status: "queued", callbackToken })
      .returning({ id: jobs.id });
    await getDb().update(splats).set({ status: "processing" }).where(eq(splats.id, splatId));

    let instanceId: string | null;
    if (localLaunchEnabled()) {
      launchJobLocal({ jobId: created.id, splatId, callbackToken });
      instanceId = null;
    } else {
      instanceId = await launchJob({
        jobId: created.id,
        splatId,
        callbackToken,
        workerImageUri: workerImageUri(),
        ecrRegistry: ecrRegistry(),
      });
    }

    const [job] = await getDb()
      .update(jobs)
      .set({ status: "launching", ec2InstanceId: instanceId })
      .where(eq(jobs.id, created.id))
      .returning(jobReadColumns);
    return NextResponse.json(job, { status: 201 });
  },
);
