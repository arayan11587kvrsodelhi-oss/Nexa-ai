import { NextRequest, NextResponse } from "next/server";
import { WebSearchService } from "@/lib/search/web-search";
import { requireUser } from "@/lib/auth/guard";
import { ApiError, toErrorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // Web search itself is not user-owned, but search is an authenticated
    // capability: an anonymous caller must not consume provider quota.
    await requireUser(req);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw ApiError.badRequest("A JSON body is required.");
    }

    const query = String(body.query || "").trim();
    const limit = typeof body.limit === "number" ? body.limit : 4;

    if (!query) {
      throw ApiError.badRequest("Search query is required.");
    }

    const searchResult = await WebSearchService.search(query, limit);
    return NextResponse.json(searchResult);
  } catch (err: unknown) {
    return toErrorResponse(err, { request: req });
  }
}
