// Codex's `/alpha/search` protocol. The request carries model/session context plus a
// command object; the response is `{ encrypted_output, output, results? }`.
// https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/codex-api/src/search.rs#L8-L29
// https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/codex-api/src/search.rs#L297-L305

import { z } from 'zod';

import { isJsonObject } from '../../shared/json-helpers.ts';
import { maxResultsForContextSize, type WebSearchFilters } from '../tools/web-search/operations.ts';

const domainListSchema = z.array(z.string());

// This is OpenAI Codex's complete SearchSettings shape. The loose object keeps future fields
// intact; local execution consumes the routing fields it implements while accepting Codex
// metadata such as allowed_callers.
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

// `commands` is validated only as "an object" — the per-kind arrays are parsed by the shared
// command engine. `looseObject` preserves every OpenAI command and nested parameter so a
// relayed request stays lossless and the local capability gate can reject unimplemented
// fields explicitly.
// https://github.com/openai/codex/blob/2f19a57704fb7b1db032bc38cf995034254eaebb/codex-rs/codex-api/src/search.rs#L31-L213
export const alphaSearchRequestSchema = z.looseObject({
  commands: z.looseObject({}).optional(),
  settings: searchSettingsSchema.optional(),
});

export type AlphaSearchRequest = z.infer<typeof alphaSearchRequestSchema>;

export interface AlphaSearchResponse {
  /** Search state Codex carries forward into a later turn, opaque to everyone between the
   *  two ends. Local execution has no state to carry, so it is null. */
  encryptedOutput: string | null;
  /** The model-facing text. Codex renders this and nothing else. */
  output: string;
  /** Result DTOs handed to clients out of band from `output`. Codex keeps them opaque so
   *  newer result variants stay forward-compatible, and so does this. */
  results?: readonly unknown[];
}

/** Why a body could not be read as this protocol, so the ending stage can say so in the
 *  synthesized failure rather than reporting a bare status. */
export type AlphaSearchResponseVerdict =
  | { readonly ok: true; readonly response: AlphaSearchResponse }
  | { readonly ok: false; readonly reason: string };

export const parseAlphaSearchResponse = (body: unknown): AlphaSearchResponseVerdict => {
  if (!isJsonObject(body)) return { ok: false, reason: 'the body is not a JSON object' };
  const { encrypted_output: encryptedOutput, output, results } = body;
  if (typeof output !== 'string') return { ok: false, reason: '`output` is missing or not a string' };
  // `encrypted_output` is `Option<String>` without a serde default, so Codex's own client
  // requires the key and accepts null in it. Demanding the same here surfaces a truncated
  // upstream at the gateway instead of as a deserialization failure inside the client.
  if (encryptedOutput !== null && typeof encryptedOutput !== 'string') {
    return { ok: false, reason: '`encrypted_output` is missing or is neither a string nor null' };
  }
  if (results !== undefined && results !== null && !Array.isArray(results)) {
    return { ok: false, reason: '`results` is neither absent nor an array' };
  }
  return {
    ok: true,
    response: {
      encryptedOutput,
      output,
      ...(Array.isArray(results) ? { results } : {}),
    },
  };
};

export const renderAlphaSearchResponse = (response: AlphaSearchResponse): Record<string, unknown> => ({
  encrypted_output: response.encryptedOutput,
  output: response.output,
  ...(response.results === undefined ? {} : { results: response.results }),
});

export const webSearchFiltersFromSettings = (settings: AlphaSearchRequest['settings']): WebSearchFilters => {
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
