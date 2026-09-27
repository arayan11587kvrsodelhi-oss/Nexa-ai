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
    const providerType = resolveProviderType(provider, "ollama");

    // FreeLLMAPI connectivity is verified against the server-side configuration
    // only: a caller may not point NEXA at an arbitrary URL, nor supply its key.
    if (providerType === "freellmapi" && (baseUrl || apiKey)) {
      throw ApiError.badRequest(
        "The FreeLLMAPI endpoint and API key are server-side configuration (FREELLMAPI_BASE_URL / FREELLMAPI_API_KEY) and cannot be provided per request."
      );
    }

    let result: ProviderConnectionResult;
    if (providerType === "freellmapi") {
      result = await new FreeLLMAPIProvider().testConnection();
    } else {
      result = await createProvider(providerType, { baseUrl, apiKey }).testConnection();
    }

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err, { request: req });
  }
}
