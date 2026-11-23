import { z } from 'zod';

import type { WebSearchUsageRecord } from '../../repo/types.ts';
import { createProviderEnding } from '../chat/shared/enter-upstream.ts';
import { billableCall, type CallPerformanceFacts, type CallUsageFacts, observedTokenUsage, observeIdentity, priceCall, recordCall, scalarCallFacts } from '../pipeline/call-metering.ts';
import { edgeHttp, type HttpDeliveryFacts, type HttpInput, type HttpOutput, jsonHttpResponse, stripFlowayAuth } from '../pipeline/edge-http.ts';
import { type CandidateRequest, type CandidatesRequest, createFailover } from '../pipeline/failover.ts';
import { GATEWAY_HTTP_ENTRY, type GatewayHttpFacts, isUploadError } from '../pipeline/host.ts';
import { forwardHttp, header, openAiApiError, requestBytes } from '../pipeline/non-chat.ts';
import type { GatewayServices } from '../pipeline/services.ts';
import { alphaSearchProviderTargets } from '../providers/upstreams.ts';
import { resolveAlphaSearchRoute } from '../tools/web-search/alpha-search/upstream.ts';
import { assertLocalWebSearchSupport, executeOperationToText, isSearchResponseLength, maxResultsForContextSize, parseWebSearchOperations, startBatchFetch, UnsupportedLocalWebSearchFeatureError, type WebSearchExecutionSession, type WebSearchFilters } from '../tools/web-search/operations.ts';
import { type SearchUsageRecords, writeSearchUsage } from '../tools/web-search/write-search-usage.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import { Bytes, compose, defineEnding, defineStage, link } from '@floway-dev/pipeline';
import { isJsonMediaType } from '@floway-dev/protocols/common';
import type { ProviderAlphaSearchOutput } from '@floway-dev/provider';

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
type AlphaAnswer = HttpOutput & SearchUsageRecords;
const outcomeKey = 'response.alphaSearch';
const callEntry = [...GATEWAY_HTTP_ENTRY, 'request.payload', 'route.candidate'] as const;
const callExit = ['response.http', 'response.modelKey', outcomeKey] as const;
const alphaAnswerKeys = ['response.http', 'response.searchUsage.records'] as const;

const prepareAlphaSearch = defineStage<GatewayHttpFacts, Resolved, ProviderAlphaSearchOutput, AlphaAnswer, Pick<GatewayServices, 'providers' | 'modelsRefresh' | 'webSearchProvider'>>({
  name: 'prepareAlphaSearch',
  through: {
    request: {
      needs: ['request.http', 'request.auth.apiKeyId', 'request.auth.user', 'request.route.upstreamIds', 'request.route.runtimeLocation'],
      consumes: [], provides: ['request.payload', 'route.candidates'],
    },
    response: {
      needs: callExit,
      consumes: ['response.modelKey', outcomeKey],
      provides: alphaAnswerKeys,
    },
  },
  return: { provides: alphaAnswerKeys },
  execute: async (facts, scope) => {
    const http = facts['request.http'];
    const records: WebSearchUsageRecord[] = [];
    const reply = (response: HttpResponseFacts): AlphaAnswer => ({
      'response.http': response,
      'response.searchUsage.records': records,
    });
    if (isUploadError(http.body)) return reply(openAiApiError(502, http.body.error.message, scope.clock()));
    let body: unknown = {};
    if (isJsonMediaType(header(http.headers, 'content-type'))) {
      try {
        body = JSON.parse(requestBytes(http).utf8());
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return reply(jsonHttpResponse(400, { error: 'Malformed JSON in request body' }, scope.clock()));
      }
    }
    const parsed = alphaSearchRequestSchema.safeParse(body);
    if (!parsed.success) return reply(jsonHttpResponse(400, { error: parsed.error.issues[0]?.message ?? 'Invalid input' }, scope.clock()));

    const config = await scope.services.webSearchProvider.alphaSearch();
    if (!config.enabled) {
      const body = await localSearch(parsed.data, facts['request.auth.apiKeyId'], scope.services.webSearchProvider, scope.signal, row => { records.push(row); });
      return reply(jsonHttpResponse(200, body, scope.clock()));
    }
    const { candidate, staleRefreshes } = await resolveAlphaSearchRoute(scope.services.providers, facts, config);
    for (const target of staleRefreshes) scope.defer('models.refresh', scope.services.modelsRefresh(target));
    if (candidate === undefined) return reply(openAiApiError(404, 'Search model not found.', scope.clock()));
    const { model: _clientModel, ...payload } = parsed.data;
    const {
      'response.http': response,
      'response.modelKey': _modelKey,
      [outcomeKey]: outcome,
      ...result
    } = await scope.next({ ...facts, 'request.payload': payload, 'route.candidates': [candidate] });
    const forwarded = forwardHttp(response, null);
    const outgoing = outcome.kind === 'error' && forwarded.body === null && (forwarded.transportError !== undefined || outcome.source === 'local')
      ? { ...forwarded, headers: [...forwarded.headers.filter(([name]) => name.toLowerCase() !== 'content-type'), ['content-type', 'application/json'] as const], body: Bytes.fromUtf8(JSON.stringify(outcome.error)) }
      : forwarded;
    return { ...result, ...reply(outgoing) };
  },
});

const observeAlphaSearchCall = defineStage<Attempt, Attempt, ProviderAlphaSearchOutput, ProviderAlphaSearchOutput & CallUsageFacts & CallPerformanceFacts>({
  name: 'observeAlphaSearchCall',
  through: {
    request: { needs: ['route.candidate'], consumes: [], provides: [] },
    response: { needs: callExit, consumes: [], provides: ['response.call.usage', 'response.call.performance'] },
  },
  execute: async (facts, scope) => {
    const response = await scope.next(facts);
    const call = response[outcomeKey].kind === 'ok'
      ? billableCall(scope, observeIdentity(facts['route.candidate'], response['response.modelKey']), 'completed', observedTokenUsage(null))
      : null;
    return { ...response, ...scalarCallFacts(scope, call, null) };
  },
});

const keepCodexTurnMetadata = defineStage<HttpInput, HttpInput, HttpOutput, HttpOutput>({
  name: 'keepCodexTurnMetadata',
  through: {
    request: { needs: ['request.http'], consumes: [], provides: ['request.http'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, scope) => {
    const http = facts['request.http'];
    // https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/codex-api/src/endpoint/search.rs
    const headers = http.headers.filter(([name]) => name.toLowerCase() === 'x-codex-turn-metadata');
    return await scope.next(headers.length === http.headers.length ? facts : { ...facts, 'request.http': { ...http, headers } });
  },
});

const call = compose<Attempt & ProviderAlphaSearchOutput, GatewayServices>()('alpha-search.egress', {
  entry: callEntry,
  exit: callExit,
  stages: [recordCall(null), priceCall, observeAlphaSearchCall, keepCodexTurnMetadata],
  targets: alphaSearchProviderTargets,
  ending: createProviderEnding<Attempt, Payload, ProviderAlphaSearchOutput, {}>(
    outcomeKey,
    alphaSearchProviderTargets,
    facts => ({ 'request.payload': facts['request.payload'] }),
  ),
});

export const alphaSearchIngress = compose<GatewayHttpFacts & HttpOutput & HttpDeliveryFacts, GatewayServices>()('alpha-search.ingress', {
  entry: GATEWAY_HTTP_ENTRY,
  exit: ['response.http', 'response.delivery'] as const,
  stages: [writeSearchUsage, edgeHttp, stripFlowayAuth, prepareAlphaSearch, createFailover(outcomeKey)],
  targets: { call },
  ending: defineEnding<Attempt, ProviderAlphaSearchOutput, { call: typeof call }, GatewayServices>({
    name: 'enterCall',
    request: { needs: callEntry },
    into: {
      call: {
        request: { needs: [], consumes: [], provides: [] },
        response: { needs: callExit, consumes: [], provides: [] },
      },
    },
    execute: async (facts, scope) => await scope.into.call(facts),
  }),
});

link([alphaSearchIngress]);
