import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/server/auth";
import { HttpError, withErrorHandling } from "@/lib/server/httpError";
import { getPrisma } from "@/lib/server/prisma";
import { splatReadSelect } from "@/lib/server/selects";

const createSchema = z.object({ name: z.string().min(1) });

export const POST = withErrorHandling(async (request: Request) => {
  const user = await requireUser();

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw new HttpError(422, "Invalid request body");
  }

  const splat = await getPrisma().splat.create({
    data: { userId: user.id, name: parsed.data.name },
    select: splatReadSelect,
  });
  return NextResponse.json(splat, { status: 201 });
});

export const GET = withErrorHandling(async () => {
  const user = await requireUser();
  const splats = await getPrisma().splat.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: splatReadSelect,
  });
  return NextResponse.json(splats);
});
