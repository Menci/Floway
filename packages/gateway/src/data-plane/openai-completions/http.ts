import { tokenUsageFromOpenAICompletionsUsage } from './usage.ts';
import { createGatewayHttpHandler } from '../pipeline/host.ts';
import { createNonChatPipeline, forwardHttp, httpSucceeded, measured, parseJsonModel, respondJsonUsage, scalarHttpAttempt } from '../pipeline/non-chat.ts';
import { observeSse } from '../pipeline/observe-sse.ts';
import { isOpenAIErrorPayload } from '../shared/openai-error-payload.ts';
import { serializeSseFrame } from '../shared/sse.ts';
import { tokenUsageMeasurement } from '../shared/telemetry/usage.ts';
import { isOpenAIUsageOnlyEventShape, parseSSEStream, parseTargetStreamFrames, sseFrame } from '@floway-dev/protocols/common';
import type { OpenAICompletionsPayload } from '@floway-dev/protocols/openai-completions';
import type { ProviderHttpOutput } from '@floway-dev/provider';

const sourceApi = '/completions';
type Payload = Omit<OpenAICompletionsPayload, 'model'>;
type UsageEvent = { service_tier?: string | null; usage?: unknown };
type ClientStreamOptions = { readonly include_usage?: unknown };

const ingress = createNonChatPipeline<Payload, ProviderHttpOutput>({
  name: 'openai-completions',
  sourceApi,
  operation: 'text_completion',
  kind: 'chat',
  parse: request => {
    const parsed = parseJsonModel(request, 'OpenAI Completions');
    return 'error' in parsed ? parsed : { model: parsed.model, payload: parsed.payload as Payload };
  },
  provider: pipelines => pipelines.openaiCompletions,
  prepareProviderPayload: payload => payload.stream === true
    ? { ...payload, stream_options: { ...(payload.stream_options as ClientStreamOptions | undefined), include_usage: true } }
    : payload,
  select: candidates => candidates.filter(candidate => candidate.endpoints.openaiCompletions !== undefined),
  respond: (response, request, identity, env) => {
    const http = response['response.http'];
    if (!httpSucceeded(http)) return scalarHttpAttempt(env, forwardHttp(http), identity);
    const candidate = request['route.candidate'];
    const client = request['request.payload'];
    const declaredExclusive = candidate.providerModel.enabledFlags.includes('usage-exclusive-cached-tokens');
    const usageIdentity = `${candidate.upstreamId}/${candidate.modelId}`;
    if (client.stream !== true) {
      return respondJsonUsage(http, identity, env, sourceApi, body => {
        if (body === null || typeof body !== 'object') return null;
        const { usage, service_tier: tier } = body as UsageEvent;
        return tokenUsageFromOpenAICompletionsUsage(usage, tier, declaredExclusive, usageIdentity);
      });
    }

    let usageBlock: unknown = null;
    let serviceTier: string | null | undefined;
    const includeUsage = (client.stream_options as ClientStreamOptions | undefined)?.include_usage === true;
    return observeSse(http, identity, env, {
      frames: (body, signal) => parseTargetStreamFrames<unknown>(parseSSEStream(body, { signal }), { protocol: sourceApi }),
      encode: parsed => {
        if (parsed.type === 'done') return { wire: serializeSseFrame(sseFrame('[DONE]')), end: 'completed' };
        const event = parsed.data;
        if (isOpenAIErrorPayload(event)) return { wire: serializeSseFrame(sseFrame(JSON.stringify(event))), end: 'protocol-error' };
        if (typeof event === 'object' && event !== null) {
          const root = event as UsageEvent;
          if (root.service_tier !== undefined) serviceTier = root.service_tier;
          if (isOpenAIUsageOnlyEventShape(event)) {
            usageBlock = root.usage;
            if (!includeUsage) return { wire: null };
          }
        }
        return { wire: serializeSseFrame(sseFrame(JSON.stringify(event))) };
      },
      eofMessage: 'OpenAI Completions stream ended without a [DONE] sentinel.',
      usage: () => measured(tokenUsageMeasurement(usageBlock === null ? null : tokenUsageFromOpenAICompletionsUsage(usageBlock, serviceTier, declaredExclusive, usageIdentity))),
    });
  },
});

export const openaiCompletions = createGatewayHttpHandler(ingress, { errorStatus: () => 502, performanceOperation: 'text_completion' });
