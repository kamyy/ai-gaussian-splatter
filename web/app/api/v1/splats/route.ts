import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { splats } from "@/lib/server/db/schema";
import { HttpError, withErrorHandling } from "@/lib/server/httpError";
import { splatReadColumns } from "@/lib/server/selects";

const createSchema = z.object({ name: z.string().min(1) });

export const POST = withErrorHandling(async (request: Request) => {
  const user = await requireUser();

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw new HttpError(422, "Invalid request body");
  }

  const [splat] = await getDb()
    .insert(splats)
    .values({ userId: user.id, name: parsed.data.name })
    .returning(splatReadColumns);
  return NextResponse.json(splat, { status: 201 });
});

export const GET = withErrorHandling(async () => {
  const user = await requireUser();
  const rows = await getDb()
    .select(splatReadColumns)
    .from(splats)
    .where(eq(splats.userId, user.id))
    .orderBy(desc(splats.createdAt));
  return NextResponse.json(rows);
});
