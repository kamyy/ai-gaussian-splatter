import { and, desc, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { jobs, splats } from "@/lib/server/db/schema";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { jobReadColumns } from "@/lib/server/selects";

export const GET = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/jobs/latest">) => {
    const user = await requireUser();
    const { splatId } = await ctx.params;
    requireUuid(splatId, 404, "No jobs for this splat");

    // Ownership is enforced through the parent splat, hence the join. The
    // explicit column map keeps the result flat despite it, and keeps
    // callbackToken/ec2InstanceId out of the SQL entirely.
    const [job] = await getDb()
      .select(jobReadColumns)
      .from(jobs)
      .innerJoin(splats, eq(jobs.splatId, splats.id))
      .where(and(eq(jobs.splatId, splatId), eq(splats.userId, user.id)))
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    if (job === undefined) {
      throw new HttpError(404, "No jobs for this splat");
    }
    return NextResponse.json(job);
  },
);
