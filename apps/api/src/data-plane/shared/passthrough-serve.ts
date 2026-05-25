// Shared serve scaffold for non-LLM data-plane endpoints (embeddings, image
// generations, image edits). These bypass the LLM source/target executor
// because they have no protocol translation — the request body is forwarded
// to the chosen provider's matching endpoint and the JSON response is
// proxied back. The shape is:
//
//   resolve model -> iterate provider bindings -> first matching binding
//     -> provider call -> proxy response -> fire-and-forget usage + perf
//
// Usage extraction is provided by the caller because each endpoint family
// reports usage differently (OpenAI embeddings use `prompt_tokens`, images
// use `input_tokens`/`output_tokens`). Usage and request-performance writes
// are scheduled through the runtime's background scheduler so transient
// repo failures cannot turn a successful 200 from upstream into a 502.

import type { Context } from 'hono';

import { apiKeyUpstreamIdsFromContext } from '../../middleware/auth.ts';
import type { NonLlmServeApiName, TokenUsage } from '../../repo/types.ts';
import type { BackgroundScheduler } from '../../runtime/background.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { toInternalDebugError } from '../llm/shared/errors/internal-debug-error.ts';
import { httpResponseToResponse, ProviderModelsUnavailableError } from '../providers/models-store.ts';
import { resolveModelForRequest } from '../providers/registry.ts';
import type { ProviderCallResult, ProviderModelRecord } from '../providers/types.ts';
import type { PerformanceTelemetryContext } from './telemetry/performance.ts';
import { recordPerformanceError, recordPerformanceLatency, recordRequestPerformanceForApiKey, runtimeLocationFromRequest } from './telemetry/performance.ts';
import { recordTokenUsageForApiKey } from './telemetry/usage.ts';

// Headers we forward verbatim from a successful upstream JSON response.
// The set is intentionally narrow and matches the proxy contract that
// OpenAI clients (and the OpenAI Node SDK retry policy) expect to see:
//   - x-request-id              upstream-assigned request correlation id
//   - openai-*                  organization, model, processing-ms, version, etc.
//   - x-ratelimit-*             RPM/TPM quota signals
//   - retry-after               rate-limit / overload back-off hint
//   - cf-ray                    Cloudflare edge ray id (useful in support tickets)
// Plus content-type, which is set with an application/json fallback if the
// upstream omitted it.
const FORWARDED_RESPONSE_HEADER_PREFIXES = ['openai-', 'x-ratelimit-'] as const;
const FORWARDED_RESPONSE_HEADERS = new Set(['x-request-id', 'retry-after', 'cf-ray']);

const proxyResponseHeaders = (resp: Response): Headers => {
  const headers = new Headers({ 'content-type': resp.headers.get('content-type') ?? 'application/json' });
  for (const [name, value] of resp.headers.entries()) {
    const lower = name.toLowerCase();
    if (lower === 'content-type') continue;
    if (FORWARDED_RESPONSE_HEADERS.has(lower) || FORWARDED_RESPONSE_HEADER_PREFIXES.some(prefix => lower.startsWith(prefix))) {
      headers.set(name, value);
    }
  }
  return headers;
};

const proxyJsonResponse = (resp: Response): Response =>
  new Response(resp.body, {
    status: resp.status,
    headers: proxyResponseHeaders(resp),
  });

// hono's StatusCode union accepts the discrete numeric literals (200, 400, ...).
// The cast widens our internal `number` callsites without losing runtime safety —
// the helper is the only caller and the values it picks (400 / 404) are always
// in-range.
const apiErrorResponse = (c: Context, message: string, status: number): Response =>
  c.json({ error: { message, type: 'api_error' } }, status as 400);

const recordUpstreamPerformance = (
  scheduler: BackgroundScheduler | undefined,
  context: PerformanceTelemetryContext | undefined,
  failed: boolean,
  durationMs: number,
): void => {
  if (!context) return;
  const promise = failed ? recordPerformanceError(context, 'upstream_success') : recordPerformanceLatency(context, 'upstream_success', durationMs);
  scheduler ? scheduler(promise) : void promise;
};

// Fire-and-forget the usage record. A transient D1/KV failure here must not
// surface as a 502 to a client whose upstream call already succeeded with a
// 200 response body in hand. We log so the failure is still observable.
const scheduleUsageRecord = (scheduler: BackgroundScheduler | undefined, promise: Promise<void>): void => {
  const guarded = promise.catch(error => {
    console.error('Failed to record token usage:', error);
  });
  scheduler ? scheduler(guarded) : void guarded;
};

// Defensive JSON parse: a successful 200 with a non-JSON or unexpected body
// (rare for these endpoints, but possible if a provider proxy starts
// returning binary or a wrapped envelope) must not 502 the client; we
// simply skip usage extraction in that case.
const safeJsonClone = async (resp: Response): Promise<unknown> => {
  try {
    return await resp.clone().json();
  } catch {
    return undefined;
  }
};

const performanceContextFor = (
  apiKeyId: string | undefined,
  modelId: string,
  binding: ProviderModelRecord,
  modelKey: string,
  runtimeLocation: string,
  sourceApi: NonLlmServeApiName,
): PerformanceTelemetryContext | undefined =>
  apiKeyId
    ? {
        keyId: apiKeyId,
        model: modelId,
        upstream: binding.upstream,
        modelKey,
        sourceApi,
        targetApi: sourceApi,
        stream: false,
        runtimeLocation,
      }
    : undefined;

export interface PassthroughServeContext {
  readonly c: Context;
  readonly sourceApi: NonLlmServeApiName;
  // Already-validated public model id the client requested. The helper
  // resolves it against the provider registry; if no upstream serves the
  // id, the client sees a 404 with the standard wording.
  readonly requestedModel: string;
  // Selects which provider binding can serve this endpoint family. For
  // embeddings this is `kind === 'embedding'`; for images it gates on the
  // specific `upstreamEndpoints` entry.
  readonly acceptBinding: (binding: ProviderModelRecord) => boolean;
  // Performs the upstream HTTP call for the chosen binding. Any throw here
  // is preserved and becomes a 502 with the internal-debug envelope —
  // exceptions thrown from the actual fetch must not be silently swallowed.
  readonly call: (binding: ProviderModelRecord) => Promise<ProviderCallResult>;
  // Extracts a usage row from a parsed 2xx upstream body. Return null when
  // the body has no usage block to record.
  readonly extractUsage: (parsed: unknown) => TokenUsage | null;
  // Returned as the 400 body when no provider binding matched. Phrased
  // per-endpoint so the error tells the client which capability is missing.
  // The helper interpolates the resolved model id by calling
  // `noBindingMessage(modelId)`.
  readonly noBindingMessage: (modelId: string) => string;
}

export const passthroughServe = async (ctx: PassthroughServeContext): Promise<Response> => {
  const { c, sourceApi, requestedModel, acceptBinding, call, extractUsage, noBindingMessage } = ctx;
  const requestStartedAt = performance.now();
  const apiKeyId = c.get('apiKeyId') as string | undefined;
  const runtimeLocation = runtimeLocationFromRequest(c.req.raw);
  const scheduleBackground = backgroundSchedulerFromContext(c);
  let lastPerformance: PerformanceTelemetryContext | undefined;

  try {
    const { id: modelId, model } = await resolveModelForRequest(requestedModel, apiKeyUpstreamIdsFromContext(c));
    if (!model) {
      return apiErrorResponse(c, `No upstream provides model ${modelId}. Configure an upstream that exposes this model in the dashboard.`, 404);
    }

    for (const binding of model.providers) {
      if (!acceptBinding(binding)) continue;

      const upstreamStartedAt = performance.now();
      const { response, modelKey } = await call(binding);
      const performanceContext = performanceContextFor(apiKeyId, modelId, binding, modelKey, runtimeLocation, sourceApi);
      if (performanceContext) lastPerformance = performanceContext;

      if (!response.ok) {
        recordUpstreamPerformance(scheduleBackground, performanceContext, true, performance.now() - upstreamStartedAt);
        recordRequestPerformanceForApiKey(apiKeyId, scheduleBackground, performanceContext, true, performance.now() - requestStartedAt);
        return proxyJsonResponse(response);
      }

      recordUpstreamPerformance(scheduleBackground, performanceContext, false, performance.now() - upstreamStartedAt);
      const parsed = await safeJsonClone(response);
      const usage = parsed !== undefined ? extractUsage(parsed) : null;
      if (usage) {
        scheduleUsageRecord(
          scheduleBackground,
          recordTokenUsageForApiKey(
            apiKeyId,
            {
              model: modelId,
              upstream: binding.upstream,
              modelKey,
              cost: binding.provider.getPricingForModelKey(modelKey),
            },
            usage,
          ),
        );
      }
      recordRequestPerformanceForApiKey(apiKeyId, scheduleBackground, performanceContext, false, performance.now() - requestStartedAt);
      return proxyJsonResponse(response);
    }

    return apiErrorResponse(c, noBindingMessage(modelId), 400);
  } catch (e) {
    if (e instanceof ProviderModelsUnavailableError) {
      const proxied = httpResponseToResponse(e.httpResponse);
      if (proxied) return proxied;
    }
    recordRequestPerformanceForApiKey(apiKeyId, scheduleBackground, lastPerformance, true, performance.now() - requestStartedAt);
    return c.json({ error: toInternalDebugError(e, sourceApi) }, 502);
  }
};

// Body-parse failures are source-specific (JSON for embeddings/generations,
// multipart for edits), so callers need a way to return a uniformly shaped
// 400 without depending on internal helpers.
export const passthroughApiError = (c: Context, message: string, status: number): Response =>
  apiErrorResponse(c, message, status);
