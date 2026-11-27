import { z } from 'zod';

import { maxResultsForContextSize, type WebSearchFilters } from '../../tools/web-search/operations.ts';

// https://github.com/openai/codex/blob/2f19a57704fb7b1db032bc38cf995034254eaebb/codex-rs/codex-api/src/search.rs#L215-L295
const domainList = z.array(z.string());
const searchSettings = z.looseObject({
  filters: z.looseObject({
    allowed_domains: domainList.exactOptional(),
    blocked_domains: domainList.exactOptional(),
  }).exactOptional(),
  user_location: z.looseObject({
    type: z.literal('approximate').exactOptional(),
    city: z.string().exactOptional(),
    region: z.string().exactOptional(),
    country: z.string().exactOptional(),
    timezone: z.string().exactOptional(),
  }).exactOptional(),
  search_context_size: z.enum(['low', 'medium', 'high']).exactOptional(),
  image_settings: z.looseObject({
    max_results: z.number().int().nonnegative().exactOptional(),
    caption: z.boolean().exactOptional(),
  }).exactOptional(),
  allowed_callers: z.array(z.enum(['direct', 'shell', 'code_interpreter'])).exactOptional(),
  external_web_access: z.union([z.boolean(), z.enum(['cached', 'indexed', 'live'])]).exactOptional(),
});

export const alphaSearchRequest = z.looseObject({
  commands: z.looseObject({}).exactOptional(),
  settings: searchSettings.exactOptional(),
});

export const filtersFromSettings = (settings: z.infer<typeof searchSettings> | undefined): WebSearchFilters => {
  const filters: WebSearchFilters = { maxResults: maxResultsForContextSize(settings?.search_context_size) };
  if (settings?.filters?.allowed_domains) filters.allowedDomains = settings.filters.allowed_domains;
  if (settings?.filters?.blocked_domains) filters.blockedDomains = settings.filters.blocked_domains;
  const location = settings?.user_location;
  if (location && (location.city !== undefined || location.region !== undefined || location.country !== undefined || location.timezone !== undefined)) {
    filters.userLocation = {
      ...(location.city === undefined ? {} : { city: location.city }),
      ...(location.region === undefined ? {} : { region: location.region }),
      ...(location.country === undefined ? {} : { country: location.country }),
      ...(location.timezone === undefined ? {} : { timezone: location.timezone }),
    };
  }
  return filters;
};
