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

import { type AuthVars, apiKeyFromContext, effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { type CtxWithJson, zValidator } from '../../middleware/zod-validator.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import { mountPublicRoute } from '../public-route.ts';
import { relayFetchedResponse } from '../tools/web-search/alpha-search/relay-response.ts';
import { resolveAlphaSearchDispatcher } from '../tools/web-search/alpha-search/upstream.ts';
import { loadWebSearchConfig } from '../tools/web-search/config.ts';
import { assertLocalWebSearchSupport, executeOperationToText, maxResultsForContextSize, parseWebSearchOperations, startBatchFetch, UnsupportedLocalWebSearchFeatureError, type WebSearchExecutionSession, type WebSearchFilters } from '../tools/web-search/operations.ts';
import { resolveConfiguredWebSearchProvider } from '../tools/web-search/provider.ts';
import type { ConfiguredWebSearchProvider } from '../tools/web-search/types.ts';
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

const alphaSearch = async (c: CtxWithJson<typeof alphaSearchRequestSchema>): Promise<Response> => {
  const body = c.req.valid('json');
  const webSearchConfig = await loadWebSearchConfig();
  if (webSearchConfig.passthroughOpenAiSearch.enabled) {
    const dispatcher = await resolveAlphaSearchDispatcher({
      config: webSearchConfig.passthroughOpenAiSearch,
      upstreamIds: effectiveUpstreamIdsFromContext(c),
      scheduler: backgroundSchedulerFromContext(c),
      runtimeLocation: getRuntimeLocation(c.req.raw),
    });
    const headers = new Headers();
    const turnMetadata = c.req.header('x-codex-turn-metadata');
    if (turnMetadata !== undefined) headers.set('x-codex-turn-metadata', turnMetadata);
    const response = await dispatcher(body, c.req.raw.signal, headers);
    return relayFetchedResponse(response);
  }

  try {
    assertLocalWebSearchSupport(body.commands ?? {});
  } catch (error) {
    if (error instanceof UnsupportedLocalWebSearchFeatureError) {
      return c.json({ encrypted_output: null, output: error.message });
    }
    throw error;
  }

  let configuredProvider: Promise<ConfiguredWebSearchProvider> | undefined;
  const session: WebSearchExecutionSession = {
    getProvider: () => {
      configuredProvider ??= Promise.resolve(resolveConfiguredWebSearchProvider(webSearchConfig));
      return configuredProvider;
    },
    filters: filtersFromSettings(body.settings),
    apiKeyId: apiKeyFromContext(c).id,
    pageCache: new Map(),
    // Codex renders `output` as plain text; the search-action sources list
    // is a Responses wire concern with no place here.
    includeSearchActionSources: false,
    signal: c.req.raw.signal,
  };

  const parsed = parseWebSearchOperations(body.commands ?? {});
  if (parsed.kind !== 'ops' || parsed.ops.length === 0) {
    return c.json({
      encrypted_output: null,
      output: 'No web search commands were provided. Populate at least one of `search_query`, `open`, or `find`.',
    });
  }

  // One batched provider.fetchPage covers every open/find URL; each op then
  // renders its own text block. The shared parser's canonical order is
  // search_query → open → find, preserving array order within each command
  // kind.
  const batch = await startBatchFetch(parsed, session);
  const blocks = await Promise.all(parsed.ops.map(op => executeOperationToText(op, session, batch)));

  return c.json({ encrypted_output: null, output: blocks.join('\n\n') });
};

type AlphaSearchRoute = typeof PUBLIC_DATA_PLANE_ROUTES.alphaSearch | typeof PUBLIC_DATA_PLANE_ROUTES.codexAlphaSearch;

export const mountAlphaSearchRoute = (app: Hono<{ Variables: AuthVars }>, route: AlphaSearchRoute) => {
  mountPublicRoute(route, (method, path) => app.on(method, path, zValidator('json', alphaSearchRequestSchema), alphaSearch));
};

export const mountAlphaSearchRoutes = (app: Hono<{ Variables: AuthVars }>) => {
  mountAlphaSearchRoute(app, PUBLIC_DATA_PLANE_ROUTES.alphaSearch);
};
