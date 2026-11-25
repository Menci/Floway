import { assertLocalWebSearchSupport, executeOperationToText, isSearchResponseLength, maxResultsForContextSize, parseWebSearchOperations, startBatchFetch, UnsupportedLocalWebSearchFeatureError, type WebSearchExecutionSession, type WebSearchFilters } from '../../tools/web-search/operations.ts';
import { resolveConfiguredWebSearchProvider } from '../../tools/web-search/provider.ts';
import type { ConfiguredWebSearchProvider, WebSearchConfig } from '../../tools/web-search/types.ts';
import type { AlphaSearchRequest } from '../schema.ts';

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

export const executeLocalAlphaSearch = async (
  body: AlphaSearchRequest,
  webSearchConfig: WebSearchConfig,
  apiKeyId: string,
  signal: AbortSignal,
) => {
  try {
    assertLocalWebSearchSupport(body.commands ?? {});
  } catch (error) {
    if (error instanceof UnsupportedLocalWebSearchFeatureError) {
      return { encrypted_output: null, output: error.message };
    }
    throw error;
  }

  const responseLength = body.commands?.response_length;
  let configuredProvider: Promise<ConfiguredWebSearchProvider> | undefined;
  const session: WebSearchExecutionSession = {
    ...(isSearchResponseLength(responseLength) ? { responseLength } : {}),
    getProvider: () => {
      configuredProvider ??= Promise.resolve(resolveConfiguredWebSearchProvider(webSearchConfig));
      return configuredProvider;
    },
    filters: filtersFromSettings(body.settings),
    apiKeyId,
    pageCache: new Map(),
    // Codex renders `output` as plain text; the search-action sources list
    // is an OpenAI Responses wire concern with no place here.
    includeSearchActionSources: false,
    signal,
  };

  const parsed = parseWebSearchOperations(body.commands ?? {});
  if (parsed.kind !== 'ops' || parsed.ops.length === 0) {
    return {
      encrypted_output: null,
      output: 'No web search commands were provided. Populate at least one of `search_query`, `open`, or `find`.',
    };
  }

  // One batched provider.fetchPage covers every open/find URL; each op then
  // renders its own text block. The shared parser's canonical order is
  // search_query → open → find, preserving array order within each command
  // kind.
  const batch = await startBatchFetch(parsed, session);
  const blocks = await Promise.all(parsed.ops.map(op => executeOperationToText(op, session, batch)));

  return { encrypted_output: null, output: blocks.join('\n\n') };
};
