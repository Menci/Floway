// Codex `/alpha/search` compatibility endpoint. The private request carries
// model/session context plus a command object; the response is
// `{ encrypted_output?, output, results? }`.
// https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/codex-api/src/search.rs#L8-L29
// https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/codex-api/src/search.rs#L297-L305
// Clients append `alpha/search` to an OpenAI-compatible provider base. The
// aliases below cover Floway's general root and `/v1` base conventions.
// https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/codex-api/src/endpoint/search.rs#L31-L47
//
// In the default mode, Floway executes supported commands through the general
// configured search provider and renders a local `{ encrypted_output: null,
// output }` response. Passthrough mode instead returns the selected Codex or
// Custom provider response verbatim, preserving its optional structured data.
//
// The shared data-plane auth middleware guards every alias; this handler reads
// the resolved API key for per-key search-usage accounting.

import type { Hono } from 'hono';
import { z } from 'zod';

import { type AuthVars } from '../../middleware/auth.ts';
import { type CtxWithJson, zValidator } from '../../middleware/zod-validator.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import {
  buildDownstreamWireUrl,
  createGatewayPipelineServices,
  edgeHttpStage,
  gatewayApiErrorOutcome,
  gatewayJsonOutcome,
  inboundHeaderEntriesFromHono,
  materializeDownstreamResponse,
  relayedResponseHeaderEntries,
  type DownstreamHttpOutcome,
} from '../pipeline/index.ts';
import { mountPublicRoute } from '../public-route.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { readRequestBody, takeRequestBody } from '../shared/request-body.ts';
import { AlphaSearchModelNotFoundError, resolveAlphaSearchRouteCandidate } from '../tools/web-search/alpha-search/upstream.ts';
import { loadWebSearchConfig } from '../tools/web-search/config.ts';
import { assertLocalWebSearchSupport, executeOperationToText, isSearchResponseLength, maxResultsForContextSize, parseWebSearchOperations, startBatchFetch, UnsupportedLocalWebSearchFeatureError, type WebSearchExecutionSession, type WebSearchFilters } from '../tools/web-search/operations.ts';
import { alphaSearchPassthroughSubPipeline, type WebSearchPipelineServices } from '../tools/web-search/pipeline.ts';
import { resolveConfiguredWebSearchProvider } from '../tools/web-search/provider.ts';
import type { ConfiguredWebSearchProvider } from '../tools/web-search/types.ts';
import { defineStage, pipeline, runPipeline, terminal } from '@floway-dev/pipeline';
import type { HeaderEntry, Pipeline, WireRequestSnapshot } from '@floway-dev/pipeline';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

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

export type AlphaSearchRequest = z.infer<typeof alphaSearchRequestSchema>;

interface AlphaSearchPipelineInput {
  readonly 'request.http': WireRequestSnapshot;
  readonly 'request.inboundHeaders': readonly HeaderEntry[];
  readonly 'request.body': AlphaSearchRequest;
}

interface AlphaSearchOutcomeFacts extends AlphaSearchPipelineInput {
  readonly 'response.outcome': DownstreamHttpOutcome;
}

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

const localSearchOutcome = async (
  body: AlphaSearchRequest,
  env: WebSearchPipelineServices,
  signal: AbortSignal,
): Promise<DownstreamHttpOutcome> => {
  try {
    assertLocalWebSearchSupport(body.commands ?? {});
  } catch (error) {
    if (error instanceof UnsupportedLocalWebSearchFeatureError) {
      return gatewayJsonOutcome(200, { encrypted_output: null, output: error.message });
    }
    throw error;
  }

  const responseLength = body.commands?.response_length;
  const session: WebSearchExecutionSession = {
    ...(isSearchResponseLength(responseLength) ? { responseLength } : {}),
    getProvider: env.webSearchProvider,
    filters: filtersFromSettings(body.settings),
    apiKeyId: env.apiKeyId,
    pageCache: env.pageCache,
    includeSearchActionSources: false,
    signal,
  };

  const parsed = parseWebSearchOperations(body.commands ?? {});
  if (parsed.kind !== 'ops' || parsed.ops.length === 0) {
    return gatewayJsonOutcome(200, {
      encrypted_output: null,
      output: 'No web search commands were provided. Populate at least one of `search_query`, `open`, or `find`.',
    });
  }

  const batch = await startBatchFetch(parsed, session);
  const blocks = await Promise.all(parsed.ops.map(op => executeOperationToText(op, session, batch)));
  return gatewayJsonOutcome(200, { encrypted_output: null, output: blocks.join('\n\n') });
};

const executeSearch = defineStage<
  AlphaSearchPipelineInput,
  { readonly 'response.outcome': DownstreamHttpOutcome },
  DownstreamHttpOutcome,
  DownstreamHttpOutcome,
  never,
  WebSearchPipelineServices
>({
  name: 'gateway.alpha-search.execute',
  provides: ['response.outcome'],
  execute: async (facts, next, env) => {
    const config = await loadWebSearchConfig();
    if (!config.passthroughOpenAiSearch.enabled) {
      return await next({ 'response.outcome': await localSearchOutcome(facts['request.body'], env, env.signal) });
    }

    let candidate;
    try {
      candidate = await resolveAlphaSearchRouteCandidate(env.directory, config.passthroughOpenAiSearch);
    } catch (error) {
      if (error instanceof AlphaSearchModelNotFoundError) {
        env.attribution.recordError('gateway');
        return await next({ 'response.outcome': gatewayApiErrorOutcome(error.message, 404) });
      }
      throw error;
    }

    const { model: _callerModel, ...payload } = facts['request.body'];
    const http = await env.spawnSubRun(alphaSearchPassthroughSubPipeline, {
      'route.candidate': candidate,
      'request.payload': payload,
      'request.inboundHeaders': facts['request.inboundHeaders'],
    });
    return await next({
      'response.outcome': {
        status: http.status,
        statusText: http.statusText,
        headers: relayedResponseHeaderEntries(http.headers),
        body: http.body,
      },
    });
  },
});

const alphaSearchPipeline: Pipeline<
  AlphaSearchPipelineInput,
  DownstreamHttpOutcome,
  WebSearchPipelineServices
> = pipeline<AlphaSearchPipelineInput>('gateway.alpha-search')
  .use(edgeHttpStage<AlphaSearchPipelineInput>('gateway.alpha-search.edge'))
  .use(executeSearch)
  .end(terminal<AlphaSearchOutcomeFacts, DownstreamHttpOutcome, WebSearchPipelineServices>({
    name: 'gateway.alpha-search.response',
    execute: async facts => facts['response.outcome'],
  }));

const alphaSearch = async (c: CtxWithJson<typeof alphaSearchRequestSchema>): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const ctx = createGatewayCtxFromHono(c, {
    wantsStream: false,
    requestBody: takeRequestBody(requestBody),
    backgroundScheduler: backgroundSchedulerFromContext(c),
  });
  const body = c.req.valid('json');
  let configuredProvider: Promise<ConfiguredWebSearchProvider> | undefined;
  const services: WebSearchPipelineServices = {
    ...createGatewayPipelineServices(ctx),
    webSearchProvider: async () => {
      configuredProvider ??= loadWebSearchConfig().then(config => resolveConfiguredWebSearchProvider(config));
      return await configuredProvider;
    },
    pageCache: new Map(),
  };
  const outcome = await runPipeline(alphaSearchPipeline, {
    'request.http': {
      method: c.req.method,
      url: buildDownstreamWireUrl(c.req.url),
      headers: inboundHeaderEntriesFromHono(c),
      body,
      protocol: '/alpha/search',
    },
    'request.inboundHeaders': inboundHeaderEntriesFromHono(c),
    'request.body': body,
  }, {
    services,
    signal: ctx.abortSignal,
    waitUntil: ctx.backgroundScheduler,
  });
  return finalizeGatewayResponse(ctx, materializeDownstreamResponse(c, services, outcome));
};

type AlphaSearchRoute = typeof PUBLIC_DATA_PLANE_ROUTES.alphaSearch | typeof PUBLIC_DATA_PLANE_ROUTES.codexAlphaSearch;

export const mountAlphaSearchRoute = (app: Hono<{ Variables: AuthVars }>, route: AlphaSearchRoute) => {
  mountPublicRoute(route, (method, path) => app.on(method, path, zValidator('json', alphaSearchRequestSchema), alphaSearch));
};

export const mountAlphaSearchRoutes = (app: Hono<{ Variables: AuthVars }>) => {
  mountAlphaSearchRoute(app, PUBLIC_DATA_PLANE_ROUTES.alphaSearch);
};
