import { z } from 'zod';

import type { WebSearchUsageRecord } from '../../repo/types.ts';
import { answerKeys, gatewayAnswer } from '../pipeline/answer.ts';
import { edgeHttp, type HttpOutput, jsonHttpResponse } from '../pipeline/edge-http.ts';
import { type CandidateRequest, type CandidatesRequest, failover } from '../pipeline/failover.ts';
import type { GatewayHttpFacts } from '../pipeline/host.ts';
import { forwardHttp, header, openAiApiError, type RenderedAttemptResponse, requestBytes, scalarHttpAttempt } from '../pipeline/non-chat.ts';
import { observeIdentity } from '../pipeline/observe-usage.ts';
import type { GatewayServices } from '../pipeline/services.ts';
import { priceUsage, type SettlementFacts, writeSettlement } from '../pipeline/settlement.ts';
import { filterInboundHeaderEntries } from '../shared/inbound-headers.ts';
import { resolveAlphaSearchRouteCandidate } from '../tools/web-search/alpha-search/upstream.ts';
import { assertLocalWebSearchSupport, executeOperationToText, isSearchResponseLength, maxResultsForContextSize, parseWebSearchOperations, startBatchFetch, UnsupportedLocalWebSearchFeatureError, type WebSearchExecutionSession, type WebSearchFilters } from '../tools/web-search/operations.ts';
import { type SearchUsageRecords, writeSearchUsage } from '../tools/web-search/write-search-usage.ts';
import { compose, defineEnding, defineStage, type DynamicTarget, link } from '@floway-dev/pipeline';
import { isJsonMediaType } from '@floway-dev/protocols/common';
import type { ProviderHttpOutput, ProviderInput } from '@floway-dev/provider';

const domainListSchema = z.array(z.string());

// This is OpenAI Codex's complete SearchSettings shape. The loose object keeps
// future fields intact for passthrough; local providers consume the routing
// fields they implement while accepting Codex metadata such as allowed_callers.
// https://github.com/openai/codex/blob/2f19a57704fb7b1db032bc38cf995034254eaebb/codex-rs/codex-api/src/search.rs#L215-L295
const searchSettingsSchema = z.looseObject({
  filters: z.looseObject({
    allowed_domains: domainListSchema.optional(),
    blocked_domains: domainListSchema.optional(),
  }).optional(),
  user_location: z.looseObject({
    type: z.literal('approximate').optional(),
    city: z.string().optional(),
    region: z.string().optional(),
    country: z.string().optional(),
    timezone: z.string().optional(),
  }).optional(),
  search_context_size: z.enum(['low', 'medium', 'high']).optional(),
  image_settings: z.looseObject({
    max_results: z.number().int().nonnegative().optional(),
    caption: z.boolean().optional(),
  }).optional(),
  allowed_callers: z.array(z.enum(['direct', 'shell', 'code_interpreter'])).optional(),
  external_web_access: z.union([
    z.boolean(),
    z.enum(['cached', 'indexed', 'live']),
  ]).optional(),
});

// `commands` is validated only as "an object" — the per-kind arrays are
// parsed by the shared command engine. `looseObject` preserves every OpenAI
// command and nested parameter so passthrough stays lossless and the local
// capability gate can reject unimplemented fields explicitly.
const alphaSearchRequestSchema = z.looseObject({
  commands: z.looseObject({}).optional(),
  settings: searchSettingsSchema.optional(),
});

type AlphaSearchRequest = z.infer<typeof alphaSearchRequestSchema>;

const filtersFromSettings = (settings: AlphaSearchRequest['settings']): WebSearchFilters => {
  const filters: WebSearchFilters = {
    maxResults: maxResultsForContextSize(settings?.search_context_size),
  };
  if (settings?.filters?.allowed_domains) filters.allowedDomains = settings.filters.allowed_domains;
  if (settings?.filters?.blocked_domains) filters.blockedDomains = settings.filters.blocked_domains;
  const loc = settings?.user_location;
  if (loc && (loc.city !== undefined || loc.region !== undefined || loc.country !== undefined || loc.timezone !== undefined)) {
    filters.userLocation = {
      ...(loc.city !== undefined ? { city: loc.city } : {}),
      ...(loc.region !== undefined ? { region: loc.region } : {}),
      ...(loc.country !== undefined ? { country: loc.country } : {}),
      ...(loc.timezone !== undefined ? { timezone: loc.timezone } : {}),
    };
  }
  return filters;
};

const localSearch = async (
  body: AlphaSearchRequest, apiKeyId: string, getProvider: GatewayServices['webSearchProvider'], signal: AbortSignal,
  recordUsage: WebSearchExecutionSession['recordUsage'],
): Promise<{ encrypted_output: null; output: string }> => {
  try {
    assertLocalWebSearchSupport(body.commands ?? {});
  } catch (error) {
    if (error instanceof UnsupportedLocalWebSearchFeatureError) return { encrypted_output: null, output: error.message };
    throw error;
  }

  const responseLength = body.commands?.response_length;
  const session: WebSearchExecutionSession = {
    ...(isSearchResponseLength(responseLength) ? { responseLength } : {}),
    getProvider,
    filters: filtersFromSettings(body.settings),
    apiKeyId,
    recordUsage,
    pageCache: new Map(),
    includeSearchActionSources: false,
    signal,
  };

  const parsed = parseWebSearchOperations(body.commands ?? {});
  if (parsed.kind !== 'ops' || parsed.ops.length === 0) {
    return { encrypted_output: null, output: 'No web search commands were provided. Populate at least one of `search_query`, `open`, or `find`.' };
  }

  const batch = await startBatchFetch(parsed, session);
  const blocks = await Promise.all(parsed.ops.map(op => executeOperationToText(op, session, batch)));
  return { encrypted_output: null, output: blocks.join('\n\n') };
};

type Payload = Record<string, unknown>;
interface PayloadFacts { readonly 'request.payload': Payload }
type Resolved = GatewayHttpFacts & PayloadFacts & CandidatesRequest;
type Attempt = GatewayHttpFacts & PayloadFacts & CandidateRequest;
type AlphaPorts = Pick<GatewayServices, 'providers' | 'webSearchProvider'>;
type Targets = { provider: DynamicTarget<string, ProviderInput<Payload>, ProviderHttpOutput, GatewayServices> };
type AlphaAnswer = RenderedAttemptResponse & SearchUsageRecords;
const alphaAnswerKeys = [...answerKeys, 'response.searchUsage.records'];

const prepareAlphaSearch = defineStage<GatewayHttpFacts, Resolved, AlphaAnswer, AlphaAnswer, AlphaPorts>({
  name: 'prepareAlphaSearch',
  through: {
    request: {
      needs: ['request.http', 'request.auth.apiKeyId', 'request.auth.user', 'request.route.upstreamIds', 'request.route.runtimeLocation'],
      consumes: [], provides: ['request.payload', 'route.candidates'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: alphaAnswerKeys },
  execute: async (facts, next, env) => {
    const http = facts['request.http'];
    const records: WebSearchUsageRecord[] = [];
    const reply = (response: RenderedAttemptResponse['response.http']): AlphaAnswer => ({
      ...gatewayAnswer(env, response),
      'response.searchUsage.records': records,
    });
    let body: unknown = {};
    if (isJsonMediaType(header(http.headers, 'content-type'))) {
      try {
        body = JSON.parse(requestBytes(http).utf8());
      } catch {
        return reply(jsonHttpResponse(400, { error: 'Malformed JSON in request body' }, env.clock()));
      }
    }
    const parsed = alphaSearchRequestSchema.safeParse(body);
    if (!parsed.success) return reply(jsonHttpResponse(400, { error: parsed.error.issues[0]?.message ?? 'Invalid input' }, env.clock()));

    const config = await env.services.webSearchProvider.alphaSearch();
    if (!config.enabled) {
      const body = await localSearch(parsed.data, facts['request.auth.apiKeyId'], env.services.webSearchProvider, env.signal, row => { records.push(row); });
      return reply(jsonHttpResponse(200, body, env.clock()));
    }
    const candidate = await resolveAlphaSearchRouteCandidate(env.services.providers, facts, config);
    if (candidate === undefined) return reply(openAiApiError(404, 'Search model not found.', env.clock()));
    const { model: _clientModel, ...payload } = parsed.data;
    return await next({ ...facts, 'request.payload': payload, 'route.candidates': [candidate] });
  },
});

const enterUpstream = defineEnding<Attempt, AlphaAnswer, Targets, Pick<GatewayServices, 'providers'>>({
  name: 'enterUpstream',
  request: { needs: ['request.http', 'request.payload', 'route.candidate'] },
  into: {
    provider: {
      request: { needs: [], consumes: ['request.http'], provides: ['provider.model', 'request.headers'] },
      response: { needs: ['response.http', 'response.modelKey'], consumes: [], provides: alphaAnswerKeys },
    },
  },
  execute: async ({ 'request.http': http, ...facts }, into, env) => {
    const candidate = facts['route.candidate'];
    const provider = env.services.providers.resolve(candidate.upstreamId);
    const headers = http.headers.filter(([name]) => name.toLowerCase() === 'x-codex-turn-metadata');
    const result = await into.provider(candidate.upstreamId, {
      ...facts,
      'provider.model': candidate.providerModel,
      'request.headers': filterInboundHeaderEntries(headers, provider.inboundHeaderAllowlist),
    });
    const identity = observeIdentity(candidate, result['response.modelKey']);
    return {
      ...result, ...scalarHttpAttempt(env, forwardHttp(result['response.http'], null), identity),
      'response.source': 'upstream',
      'response.searchUsage.records': [],
    };
  },
});

export const alphaSearchIngress = compose<GatewayHttpFacts, HttpOutput & SettlementFacts, GatewayServices, Targets>('alpha-search.ingress', {
  stages: [writeSearchUsage, writeSettlement(null), priceUsage, edgeHttp, prepareAlphaSearch, failover],
  targets: {
    provider: {
      entry: ['provider.model', 'request.headers', 'request.payload'],
      exit: ['response.http', 'response.modelKey'],
      resolve(upstreamId, { providers }) {
        const pipeline = providers.resolve(upstreamId).pipelines.alphaSearch;
        if (pipeline === undefined) throw new Error('Selected upstream does not support OpenAI search passthrough');
        return pipeline;
      },
    },
  },
  ending: enterUpstream,
});

link([alphaSearchIngress]);
