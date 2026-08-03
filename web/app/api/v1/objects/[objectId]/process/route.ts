import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { generateCallbackToken, launchJob } from "@/lib/server/ec2Launcher";
import { getEnv } from "@/lib/server/env";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { getPrisma } from "@/lib/server/prisma";
import { checkAndIncrementGlobalDaily } from "@/lib/server/rateLimit";
import { jobReadSelect } from "@/lib/server/selects";

// Populated from the ECR repo CDK stack output once infra is deployed
// (plan §9) — placeholders for local/pre-deploy development.
function workerImageUri(): string {
  return process.env.WORKER_IMAGE_URI ?? "REPLACE_WITH_ECR_IMAGE_URI";
}

function ecrRegistry(): string {
  return process.env.ECR_REGISTRY ?? "REPLACE_WITH_ECR_REGISTRY";
}

export const POST = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/objects/[objectId]/process">) => {
    const env = getEnv();
    const user = await requireUser();
    const { objectId } = await ctx.params;
    requireUuid(objectId, 404, "Object not found");

    const splat = await getPrisma().splat.findFirst({ where: { id: objectId, userId: user.id } });
    if (splat === null) {
      throw new HttpError(404, "Object not found");
    }

    const uploadedCount = await getPrisma().photo.count({
      where: { splatId: objectId, uploadStatus: "Uploaded" },
    });
    if (uploadedCount < env.MIN_PHOTOS_PER_OBJECT) {
      throw new HttpError(400, `Need at least ${env.MIN_PHOTOS_PER_OBJECT} uploaded photos, have ${uploadedCount}`);
    }

    // The hard backstop, checked last so per-user/IP limits already screened
    // most abuse before this expensive step is even considered (plan §5).
    await checkAndIncrementGlobalDaily(env.GLOBAL_MAX_JOBS_PER_DAY);

    const callbackToken = generateCallbackToken();
    const created = await getPrisma().job.create({
      data: { splatId: objectId, status: "Queued", callbackToken },
    });
    await getPrisma().splat.update({ where: { id: objectId }, data: { status: "Processing" } });

    const instanceId = await launchJob({
      jobId: created.id,
      objectId,
      callbackToken,
      workerImageUri: workerImageUri(),
      ecrRegistry: ecrRegistry(),
    });

    const job = await getPrisma().job.update({
      where: { id: created.id },
      data: { status: "Launching", ec2InstanceId: instanceId },
      select: jobReadSelect,
    });
    return NextResponse.json(job, { status: 201 });
  },
);
