import { z } from 'zod';

const domainListSchema = z.array(z.string());

// This is OpenAI Codex's complete SearchSettings shape. The loose object keeps
// future fields intact; local providers consume the routing
// fields they implement while accepting Codex metadata such as allowed_callers.
// https://github.com/openai/codex/blob/2f19a57704fb7b1db032bc38cf995034254eaebb/codex-rs/codex-api/src/search.rs#L215-L295
const searchSettingsSchema = z.looseObject({
  filters: z.looseObject({
    allowed_domains: domainListSchema.exactOptional(),
    blocked_domains: domainListSchema.exactOptional(),
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
  external_web_access: z.union([
    z.boolean(),
    z.enum(['cached', 'indexed', 'live']),
  ]).exactOptional(),
});

// `commands` is validated only as "an object" — the per-kind arrays are
// parsed by the shared command engine. `looseObject` preserves every OpenAI
// command and nested parameter so provider serialization can preserve them and the local
// capability gate can reject unimplemented fields explicitly.
export const alphaSearchRequestSchema = z.looseObject({
  commands: z.looseObject({}).exactOptional(),
  settings: searchSettingsSchema.exactOptional(),
});

export type AlphaSearchRequest = z.infer<typeof alphaSearchRequestSchema>;
