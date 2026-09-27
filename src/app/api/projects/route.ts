import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { documents, projects } from "@/db/schema";
import { requireUser } from "@/lib/auth/guard";
import { toErrorResponse } from "@/lib/api/errors";
import { and, desc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const list = await db
      .select()
      .from(projects)
      .where(eq(projects.userId, user.id))
      .orderBy(desc(projects.updatedAt));

    const withCounts = await Promise.all(
      list.map(async (p) => {
        const fileList = await db
          .select({ id: documents.id })
          .from(documents)
          .where(and(eq(documents.projectId, p.id), eq(documents.userId, user.id)));
        return {
          ...p,
          fileCount: fileList.length,
          createdAt: p.createdAt.toISOString(),
          updatedAt: p.updatedAt.toISOString(),
        };
      })
    );

    return NextResponse.json({ projects: withCounts });
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const id = `prj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const name = body.name || "Untitled Project";

    const [created] = await db
      .insert(projects)
      .values({
        id,
        userId: user.id,
        name,
        description: body.description || null,
        instructions: body.instructions || null,
        modelPreference: body.modelPreference || "BALANCED",
      })
      .returning();

    return NextResponse.json({
      project: {
        ...created,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
        fileCount: 0,
      },
    });
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}
