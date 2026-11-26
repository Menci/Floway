import type { AlphaSearchRequest } from './parse.ts';
import { assertLocalWebSearchSupport, isSearchResponseLength, maxResultsForContextSize, parseWebSearchOperations, renderWebSearchCallOutput, UnsupportedLocalWebSearchFeatureError, type WebSearchCallIR, type WebSearchFilters, type WebSearchOperation } from '../tools/web-search/operations.ts';

const filtersFromSettings = (settings: AlphaSearchRequest['settings']): WebSearchFilters => {
  const filters: WebSearchFilters = {
    maxResults: maxResultsForContextSize(settings?.search_context_size),
  };
  if (settings?.filters?.allowed_domains) filters.allowedDomains = settings.filters.allowed_domains;
  if (settings?.filters?.blocked_domains) filters.blockedDomains = settings.filters.blocked_domains;
  const loc = settings?.user_location;
  if (loc && (loc.city !== undefined || loc.region !== undefined || loc.country !== undefined || loc.timezone !== undefined)) {
    filters.userLocation = {
      ...(loc.city === undefined ? {} : { city: loc.city }),
      ...(loc.region === undefined ? {} : { region: loc.region }),
      ...(loc.country === undefined ? {} : { country: loc.country }),
      ...(loc.timezone === undefined ? {} : { timezone: loc.timezone }),
    };
  }
  return filters;
};

const localOutput = (output: string) => ({ kind: 'result' as const, result: { encrypted_output: null, output } });

export const prepareLocalAlphaSearch = (body: AlphaSearchRequest) => {
  const commands = body.commands ?? {};
  try {
    assertLocalWebSearchSupport(commands);
  } catch (error) {
    if (!(error instanceof UnsupportedLocalWebSearchFeatureError)) throw error;
    return localOutput(error.message);
  }

  const parsed = parseWebSearchOperations(commands);
  if (parsed.kind !== 'ops' || parsed.ops.length === 0) {
    return localOutput('No web search commands were provided. Populate at least one of `search_query`, `open`, or `find`.');
  }

  const responseLength = commands.response_length;
  return {
    kind: 'operations' as const,
    operations: { kind: 'batch' as const, operations: parsed.ops },
    ...(isSearchResponseLength(responseLength) ? { responseLength } : {}),
    filters: filtersFromSettings(body.settings),
    includeSearchActionSources: false,
  };
};

export const renderLocalAlphaSearch = (operations: readonly WebSearchOperation[], results: readonly WebSearchCallIR[]) => {
  if (operations.length !== results.length) throw new Error('Alpha Search command and result counts differ');
  const blocks = results.map((result, index) => {
    if (operations[index]?.kind !== 'wrong-type') return renderWebSearchCallOutput(result);
    const [diagnostic] = result.results;
    if (diagnostic === undefined) throw new Error('Alpha Search command validation did not provide a diagnostic');
    return diagnostic.snippet;
  });
  return { encrypted_output: null, output: blocks.join('\n\n') };
};
