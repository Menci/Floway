// Codex `/alpha/search` — the endpoint the Codex CLI's web-search tool POSTs
// to when the model emits a `web.run`-style tool call. Instead of proxying
// chatgpt.com, we execute the requested operations through Floway's own
// configured web-search provider and return the single `output` string the
// CLI feeds back to the model.
//
// Request shape mirrors codex-rs `SearchRequest`
// (codex-rs/codex-api/src/search.rs @ 385c0a9). `commands` is an OBJECT
// keyed by command kind — `{ search_query:[{q}], open:[{ref_id}],
// find:[{ref_id,pattern}], … }` — which is byte-for-byte the same shape the
// Responses web_search shim parses, so both share `parseWebSearchOperations`
// and the whole execution engine. Command kinds we don't implement
// (`image_query`, `click`, `screenshot`, `finance`, `weather`, `sports`,
// `time`, `response_length`) surface as deterministic per-op error text
// rather than silently vanishing. `settings.filters` /
// `settings.user_location` / `settings.search_context_size` shape the
// search; the remaining request fields (`id`, `model`, `reasoning`, `input`,
// `max_output_tokens`) are inputs a real backend model would consume and
// carry no meaning for deterministic command execution, so we accept and
// ignore them.
//
// Response is codex-rs `SearchResponse` (`{ encrypted_output, output }`);
// the CLI reads only `output` (search.rs `SearchOutput::new(response.output)`).
//
// Auth is the shared `authMiddleware` that guards the rest of the namespace;
// this handler reads the resolved API key for per-key search-usage
// accounting.

import { z } from 'zod';

import { apiKeyFromContext, effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import { resolveAlphaSearchDispatcher } from '../tools/web-search/alpha-upstream.ts';
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
export const codexSearchRequestSchema = z.looseObject({
  commands: z.looseObject({}).optional(),
  settings: searchSettingsSchema.optional(),
});

type CodexSearchRequest = z.infer<typeof codexSearchRequestSchema>;

const filtersFromSettings = (settings: CodexSearchRequest['settings']): WebSearchFilters => {
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

export const codexAlphaSearch = async (c: CtxWithJson<typeof codexSearchRequestSchema>): Promise<Response> => {
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
    return await dispatcher.call(body, c.req.raw.signal, headers);
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
