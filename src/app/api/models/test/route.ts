import { NextRequest, NextResponse } from "next/server";
import { ProviderConnectionResult } from "@/lib/ai/types";
import {
  createProvider,
  isProviderType,
  PROVIDER_TYPES,
  resolveProviderType,
} from "@/lib/ai/providers/factory";
import { FreeLLMAPIProvider } from "@/lib/ai/providers/freellmapi";
import { requireUser } from "@/lib/auth/guard";
import { ApiError, toErrorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const { provider, baseUrl, apiKey } = body;

    if (provider !== undefined && provider !== null && !isProviderType(provider)) {
      throw ApiError.badRequest(
        `Unsupported provider '${String(provider)}'. Supported providers: ${PROVIDER_TYPES.join(", ")}.`
      );
    }
    const providerType = resolveProviderType(provider);

    // Phase 5.5 — SSRF: the endpoint is server-side configuration, never a
    // request value.
    //
    // Previously only the FreeLLMAPI branch refused a caller-supplied
    // `baseUrl`/`apiKey`; every other provider passed them straight through to
    // `createProvider(...)`, and the adapters fetch that URL with no
    // validation. Any authenticated user could therefore make NEXA issue an
    // arbitrary outbound HTTP request — to cloud metadata, an internal admin
    // port, or anything else reachable from the server. That is
    // server-side request forgery.
    //
    // This also restores the contract documented on `ProviderOverrides`:
    // "Only ever passed by server-side callers. Never from a request body."
    //
    // It costs no functionality: the UI sends only `provider` (verified in
    // models-panel and playground-panel), and each adapter already falls back
    // to its own environment/DB configuration when no override is supplied.
    if (baseUrl || apiKey) {
      throw ApiError.badRequest(
        "The provider endpoint and API key are server-side configuration and cannot be provided per request."
      );
    }

    let result: ProviderConnectionResult;
    if (providerType === "freellmapi") {
      result = await new FreeLLMAPIProvider().testConnection();
    } else {
      result = await createProvider(providerType).testConnection();
    }

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}
