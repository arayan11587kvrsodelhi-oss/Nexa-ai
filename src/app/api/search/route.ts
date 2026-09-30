import { NextRequest, NextResponse } from "next/server";
import { WebSearchService } from "@/lib/search/web-search";
import { requireUser } from "@/lib/auth/guard";
import { ApiError, toErrorResponse } from "@/lib/api/errors";
import { checkSessionLimit, rateLimitHeaders } from "@/lib/gateway/rate-limit-guard";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    // Web search itself is not user-owned, but search is an authenticated
    // capability: an anonymous caller must not consume provider quota.
    const user = await requireUser(req);

    // Phase 5.1 audit — this route is rate limited, and it is the clearest case
    // of the two because *every* request spends something real:
    //
    //  - `WebSearchService` dispatches to a metered Tavily/Brave credential
    //    (SEARCH_API_KEY / BRAVE_API_KEY / TAVILY_API_KEY) or to a SearXNG
    //    instance. One HTTP request here is one billable call upstream.
    //  - `limit` is taken from the caller's body and is otherwise unbounded, so
    //    a single request can ask for an arbitrarily large result set. That is
    //    the amplification that turns "cheap route" into "expensive route".
    //  - There is no other bound: no cache, no per-account daily cap, and before
    //    this change no limiter at all.
    //
    // Unlike a read-only route, failing closed here costs nothing: `requireUser`
    // above has already proven the database is reachable, so a limiter-store
    // failure means the store went down *after* auth — a genuine outage worth
    // reporting as 429 with a distinct message rather than silently allowing
    // unlimited metered spend.
    const decision = await checkSessionLimit("search", user.id);
    if (!decision.allowed) {
      return NextResponse.json(
        {
          error: decision.deniedByStoreFailure
            ? "The gateway is temporarily unable to accept requests. Please retry shortly."
            : "Too many searches. Please wait a moment and try again.",
          code: "RATE_LIMITED",
        },
        { status: 429, headers: rateLimitHeaders(decision) }
      );
    }

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
