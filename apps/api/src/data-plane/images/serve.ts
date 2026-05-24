// POST /v1/images/generations and POST /v1/images/edits — route image
// requests to the provider that declares the requested model and the
// matching image endpoint capability.
//
// Edits multipart bodies are loaded into memory via `request.formData()`;
// this caps the per-request body size at the Workers heap (~128 MB).
// Sufficient for the gpt-image-2 single-image edit case (≤50 MB image +
// ≤50 MB mask). Multi-image edits with the gpt-image-1 `image[]` array
// may exceed the heap — a streaming multipart parser is a follow-up.

import type { Context } from 'hono';

import { apiKeyUpstreamIdsFromContext } from '../../middleware/auth.ts';
import type { BackgroundScheduler } from '../../runtime/background.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { toInternalDebugError } from '../llm/shared/errors/internal-debug-error.ts';
import { httpResponseToResponse, ProviderModelsUnavailableError } from '../providers/models-store.ts';
import { resolveModelForRequest } from '../providers/registry.ts';
import type { ProviderModelRecord } from '../providers/types.ts';
import type { PerformanceTelemetryContext } from '../shared/telemetry/performance.ts';
import { recordPerformanceError, recordPerformanceLatency, recordRequestPerformanceForApiKey, runtimeLocationFromRequest } from '../shared/telemetry/performance.ts';
import { recordTokenUsageForApiKey, tokenUsageFromImagesResponse } from '../shared/telemetry/usage.ts';

interface ImagesGenerationsRequestBody {
  model?: unknown;
  prompt?: unknown;
  [key: string]: unknown;
}

type PreparedRequest =
  | { type: 'ok'; body: Record<string, unknown>; model: string }
  | { type: 'invalid'; message: string };

const prepareImagesGenerationsRequest = (body: string): PreparedRequest => {
  let request: ImagesGenerationsRequestBody;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { type: 'invalid', message: 'Image generations request body must be an object.' };
    }
    request = parsed as ImagesGenerationsRequestBody;
  } catch {
    return { type: 'invalid', message: 'Image generations request body must be valid JSON.' };
  }
  if (typeof request.model !== 'string' || request.model.length === 0) {
    return { type: 'invalid', message: 'Image generations request body must include a model string.' };
  }
  return { type: 'ok', body: request as Record<string, unknown>, model: request.model };
};

const modelsLoadErrorResponse = (error: unknown): Response | null =>
  error instanceof ProviderModelsUnavailableError ? httpResponseToResponse(error.httpResponse) : null;

const apiErrorResponse = (c: Context, message: string, status: 400 | 404): Response => c.json({ error: { message, type: 'api_error' } }, status);

type ImagesEndpoint = 'images_generations' | 'images_edits';

const internalDebugErrorResponse = (c: Context, source: ImagesEndpoint, error: unknown): Response => c.json({ error: toInternalDebugError(error, source) }, 502);

const proxyJsonResponse = (resp: Response): Response =>
  new Response(resp.body, {
    status: resp.status,
    headers: { 'content-type': resp.headers.get('content-type') ?? 'application/json' },
  });

const imagesPerformanceContext = (
  keyId: string | undefined,
  model: string,
  binding: ProviderModelRecord,
  modelKey: string,
  runtimeLocation: string,
  endpoint: ImagesEndpoint,
): PerformanceTelemetryContext | undefined =>
  keyId
    ? {
        keyId,
        model,
        upstream: binding.upstream,
        modelKey,
        sourceApi: endpoint,
        targetApi: endpoint,
        stream: false,
        runtimeLocation,
      }
    : undefined;

const recordUpstreamPerformance = (scheduler: BackgroundScheduler | undefined, context: PerformanceTelemetryContext | undefined, failed: boolean, durationMs: number): void => {
  if (!context) return;
  const promise = failed ? recordPerformanceError(context, 'upstream_success') : recordPerformanceLatency(context, 'upstream_success', durationMs);
  scheduler ? scheduler(promise) : void promise;
};

export const imagesGenerations = async (c: Context): Promise<Response> => {
  const requestStartedAt = performance.now();
  const apiKeyId = c.get('apiKeyId') as string | undefined;
  const runtimeLocation = runtimeLocationFromRequest(c.req.raw);
  const scheduleBackground = backgroundSchedulerFromContext(c);
  let lastPerformance: PerformanceTelemetryContext | undefined;

  try {
    const request = prepareImagesGenerationsRequest(await c.req.text());
    if (request.type === 'invalid') return apiErrorResponse(c, request.message, 400);

    const { id: modelId, model } = await resolveModelForRequest(request.model, apiKeyUpstreamIdsFromContext(c));
    if (!model) {
      return apiErrorResponse(c, `No upstream provides model ${modelId}. Configure an upstream that exposes this model in the dashboard.`, 404);
    }

    for (const binding of model.providers) {
      if (!binding.upstreamModel.upstreamEndpoints.includes('images_generations')) continue;

      const { model: _model, ...body } = request.body;
      const upstreamStartedAt = performance.now();
      const { response, modelKey } = await binding.provider.callImagesGenerations(binding.upstreamModel, body);
      const performanceContext = imagesPerformanceContext(apiKeyId, modelId, binding, modelKey, runtimeLocation, 'images_generations');
      if (performanceContext) lastPerformance = performanceContext;

      if (!response.ok) {
        recordUpstreamPerformance(scheduleBackground, performanceContext, true, performance.now() - upstreamStartedAt);
        recordRequestPerformanceForApiKey(apiKeyId, scheduleBackground, performanceContext, true, performance.now() - requestStartedAt);
        return proxyJsonResponse(response);
      }

      try {
        const parsed = (await response.clone().json()) as unknown;
        const usage = tokenUsageFromImagesResponse(parsed);
        recordUpstreamPerformance(scheduleBackground, performanceContext, false, performance.now() - upstreamStartedAt);
        if (usage) {
          await recordTokenUsageForApiKey(
            apiKeyId,
            {
              model: modelId,
              upstream: binding.upstream,
              modelKey,
              cost: binding.provider.getPricingForModelKey(modelKey),
            },
            usage,
          );
        }
      } catch (error) {
        recordUpstreamPerformance(scheduleBackground, performanceContext, true, performance.now() - upstreamStartedAt);
        throw error;
      }
      recordRequestPerformanceForApiKey(apiKeyId, scheduleBackground, performanceContext, false, performance.now() - requestStartedAt);
      return proxyJsonResponse(response);
    }

    return apiErrorResponse(c, `Model ${modelId} does not support the /images/generations endpoint.`, 400);
  } catch (e) {
    const response = modelsLoadErrorResponse(e);
    if (response) return response;
    recordRequestPerformanceForApiKey(apiKeyId, scheduleBackground, lastPerformance, true, performance.now() - requestStartedAt);
    return internalDebugErrorResponse(c, 'images_generations', e);
  }
};

export const imagesEdits = async (c: Context): Promise<Response> => {
  const requestStartedAt = performance.now();
  const apiKeyId = c.get('apiKeyId') as string | undefined;
  const runtimeLocation = runtimeLocationFromRequest(c.req.raw);
  const scheduleBackground = backgroundSchedulerFromContext(c);
  let lastPerformance: PerformanceTelemetryContext | undefined;

  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch (e) {
    return apiErrorResponse(c, `Image edits request body must be multipart/form-data: ${e instanceof Error ? e.message : String(e)}`, 400);
  }

  const modelRaw = form.get('model');
  if (typeof modelRaw !== 'string' || modelRaw.length === 0) {
    return apiErrorResponse(c, 'Image edits request body must include a model field.', 400);
  }

  try {
    const { id: modelId, model } = await resolveModelForRequest(modelRaw, apiKeyUpstreamIdsFromContext(c));
    if (!model) {
      return apiErrorResponse(c, `No upstream provides model ${modelId}. Configure an upstream that exposes this model in the dashboard.`, 404);
    }

    // Strip our own `model` field — provider call places it back from the
    // resolved upstreamModel's raw id. Everything else (prompt, image[],
    // mask, size, n, response_format, ...) flows through unchanged.
    const passthrough = new FormData();
    for (const [name, value] of form.entries()) {
      if (name === 'model') continue;
      passthrough.append(name, value);
    }

    for (const binding of model.providers) {
      if (!binding.upstreamModel.upstreamEndpoints.includes('images_edits')) continue;

      const upstreamStartedAt = performance.now();
      const { response, modelKey } = await binding.provider.callImagesEdits(binding.upstreamModel, passthrough);
      const performanceContext = imagesPerformanceContext(apiKeyId, modelId, binding, modelKey, runtimeLocation, 'images_edits');
      if (performanceContext) lastPerformance = performanceContext;

      if (!response.ok) {
        recordUpstreamPerformance(scheduleBackground, performanceContext, true, performance.now() - upstreamStartedAt);
        recordRequestPerformanceForApiKey(apiKeyId, scheduleBackground, performanceContext, true, performance.now() - requestStartedAt);
        return proxyJsonResponse(response);
      }

      try {
        const parsed = (await response.clone().json()) as unknown;
        const usage = tokenUsageFromImagesResponse(parsed);
        recordUpstreamPerformance(scheduleBackground, performanceContext, false, performance.now() - upstreamStartedAt);
        if (usage) {
          await recordTokenUsageForApiKey(
            apiKeyId,
            {
              model: modelId,
              upstream: binding.upstream,
              modelKey,
              cost: binding.provider.getPricingForModelKey(modelKey),
            },
            usage,
          );
        }
      } catch (error) {
        recordUpstreamPerformance(scheduleBackground, performanceContext, true, performance.now() - upstreamStartedAt);
        throw error;
      }
      recordRequestPerformanceForApiKey(apiKeyId, scheduleBackground, performanceContext, false, performance.now() - requestStartedAt);
      return proxyJsonResponse(response);
    }

    return apiErrorResponse(c, `Model ${modelId} does not support the /images/edits endpoint.`, 400);
  } catch (e) {
    const response = modelsLoadErrorResponse(e);
    if (response) return response;
    recordRequestPerformanceForApiKey(apiKeyId, scheduleBackground, lastPerformance, true, performance.now() - requestStartedAt);
    return internalDebugErrorResponse(c, 'images_edits', e);
  }
};
