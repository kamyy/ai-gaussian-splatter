/**
 * GET /api/v1/splats/[splatId]/jobs/latest: the splat's most recent worker job.
 *
 * The splat's page polls this to show pipeline progress. Each poll also checks that the job's GPU instance is still
 * alive (web/lib/server/reconcileJob.ts), because a worker that died never calls back to say so, and this poll is where
 * that gets noticed.
 */

import { and, desc, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { jobs, splats } from "@/lib/server/db/schema";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { reconcileJob } from "@/lib/server/reconcileJob";
import { jobColumns } from "@/lib/server/selects";

// Ownership is enforced through the parent splat, hence the join. The explicit column map keeps the result flat despite
// it, and keeps callbackToken/ec2InstanceId out of the SQL entirely.
async function latestJob(splatId: string, userId: string) {
  const [job] = await getDb()
    .select(jobColumns)
    .from(jobs)
    .innerJoin(splats, eq(jobs.splatId, splats.id))
    .where(and(eq(jobs.splatId, splatId), eq(splats.userId, userId)))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return job;
}

export const GET = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/jobs/latest">) => {
    const user = await requireUser();
    const { splatId } = await ctx.params;
    requireUuid(splatId, 404, "No jobs for this splat");

    let job = await latestJob(splatId, user.id);
    if (job === undefined) {
      throw new HttpError(404, "No jobs for this splat");
    }

    // This poll is where a job whose worker died gets noticed, since that worker will never call back to end it. A
    // failed EC2 lookup only postpones that to the next poll, so the job is still returned as read.
    try {
      if (await reconcileJob(job)) {
        job = (await latestJob(splatId, user.id)) ?? job;
      }
    } catch (err) {
      console.error(`Couldn't reconcile job ${job.id} against its worker instance`, err);
    }

    return NextResponse.json(job);
  },
);
