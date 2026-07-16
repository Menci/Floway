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
import { relayFetchedResponse } from '../tools/web-search/alpha-search/relay-response.ts';
import { resolveAlphaSearchDispatcher } from '../tools/web-search/alpha-search/upstream.ts';
import { executeOperationToText, maxResultsForContextSize, parseWebSearchOperations, startBatchFetch, type WebSearchExecutionSession, type WebSearchFilters } from '../tools/web-search/operations.ts';
import { resolveConfiguredWebSearchProvider } from '../tools/web-search/provider.ts';
import { loadSearchConfig } from '../tools/web-search/search-config.ts';
import type { ConfiguredWebSearchProvider } from '../tools/web-search/types.ts';

const domainListSchema = z.array(z.string());

// `filters` / `user_location` / `search_context_size` are the only settings
// that steer command execution; `looseObject` keeps the request tolerant of
// the settings a real backend would read but we don't (`image_settings`,
// `allowed_callers`, `external_web_access`).
const searchSettingsSchema = z.looseObject({
  filters: z.looseObject({
    allowed_domains: domainListSchema.optional(),
    blocked_domains: domainListSchema.optional(),
  }).optional(),
  user_location: z.looseObject({
    city: z.string().optional(),
    region: z.string().optional(),
    country: z.string().optional(),
    timezone: z.string().optional(),
  }).optional(),
  search_context_size: z.enum(['low', 'medium', 'high']).optional(),
});

// `commands` is validated only as "an object" — the per-kind arrays are
// parsed and diagnosed by `parseWebSearchOperations`, which already emits
// deterministic text for missing args, non-URL refs, wrong-typed keys, and
// unsupported command kinds. `looseObject` preserves the unimplemented keys
// so they reach that parser as unsupported ops.
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
  const searchConfig = await loadSearchConfig();
  if (searchConfig.passthroughOpenAiSearch.enabled) {
    const dispatcher = await resolveAlphaSearchDispatcher({
      config: searchConfig.passthroughOpenAiSearch,
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

  let configuredProvider: Promise<ConfiguredWebSearchProvider> | undefined;
  const session: WebSearchExecutionSession = {
    getProvider: () => {
      configuredProvider ??= Promise.resolve(resolveConfiguredWebSearchProvider(searchConfig));
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
  // search_query → open → find → unsupported keys, preserving array order
  // within each command kind.
  const batch = await startBatchFetch(parsed, session);
  const blocks = await Promise.all(parsed.ops.map(op => executeOperationToText(op, session, batch)));

  return c.json({ encrypted_output: null, output: blocks.join('\n\n') });
};

const ALPHA_SEARCH_PATHS = [
  '/alpha/search',
  '/v1/alpha/search',
] as const;

export const mountAlphaSearchRoute = (app: Hono<{ Variables: AuthVars }>, path: string) => {
  app.post(path, zValidator('json', alphaSearchRequestSchema), alphaSearch);
};

export const mountAlphaSearchRoutes = (app: Hono<{ Variables: AuthVars }>) => {
  for (const path of ALPHA_SEARCH_PATHS) {
    mountAlphaSearchRoute(app, path);
  }
};
