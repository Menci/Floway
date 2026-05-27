// Centralized zod schemas for every control-plane route that carries a JSON
// body or non-trivial query string. Two purposes:
//
// 1. Runtime guard — zValidator rejects malformed input before it reaches a
//    handler, with a 400 + `{ error: msg }` response matching the pre-existing
//    hand-written validation shape.
//
// 2. Type inference for the Hono RPC client — `hc<AppType>(...)` reads the
//    schemas attached to each route to type `$post({ json })`, `$patch({ json })`,
//    `$get({ query })`, etc. The frontend therefore gets autocomplete on the
//    request shape without a separate codegen step.
//
// Deep upstream-config validation (e.g. Azure URL hostname rules, custom
// pathOverrides URL parsing) intentionally stays in the handler functions —
// they own the canonical error messages and downstream cache invalidation. The
// schemas here describe the shape the dashboard sends.

import { z } from 'zod';

import { OPTIONAL_FLAGS, parseFlagOverridesWire } from '../data-plane/providers/flags.ts';

// --- shared atoms ---

const knownFlagIds = new Set<string>(OPTIONAL_FLAGS.map(f => f.id));

// Reuse the runtime parseFlagOverridesWire so unknown-id and type errors
// produce the same messages the dashboard already surfaces. z.unknown() →
// transform keeps the schema-validated output typed as Record<string, boolean>
// for the RPC client.
const flagOverridesSchema = z.unknown().transform((value, ctx): Record<string, boolean> => {
  try {
    return parseFlagOverridesWire(value);
  } catch (e) {
    ctx.issues.push({ code: 'custom', message: e instanceof Error ? e.message : String(e), input: value });
    return z.NEVER as never;
  }
});

const flagOverrideValuesSchema = z.record(z.string(), z.boolean()).refine(
  overrides => Object.keys(overrides).every(id => knownFlagIds.has(id)),
  'Unknown flag id in deployment overrides',
);

const azureDeploymentSchema = z.object({
  deployment: z.string().min(1),
  publicModelId: z.string().optional(),
  supportedEndpoints: z.array(z.string()).min(1),
  display_name: z.string().optional(),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cache_read: z.number().optional(),
    cache_write: z.number().optional(),
  }).optional(),
  flagOverrides: z.object({
    enabled: z.boolean(),
    values: flagOverrideValuesSchema,
  }).optional(),
  limits: z.object({
    max_context_window_tokens: z.number().optional(),
    max_prompt_tokens: z.number().optional(),
    max_output_tokens: z.number().optional(),
  }).optional(),
});

const customConfigSchema = z.object({
  baseUrl: z.string().min(1),
  // Records written before authStyle existed default to bearer; the runtime
  // parser in shared/upstream/custom.ts uses the same default, so accept
  // omitted authStyle here for parity with import/legacy payloads.
  authStyle: z.enum(['bearer', 'anthropic']).optional(),
  // Generation endpoints only — embeddings routing is decided per-model from
  // `kind === 'embedding'`, not from this list (see CLAUDE.md).
  supportedEndpoints: z.array(z.enum(['/chat/completions', '/responses', '/v1/messages'])),
  bearerToken: z.string().optional(),
  // PATCH passes `null` to explicitly clear pathOverrides; nullable() keeps
  // that escape hatch.
  pathOverrides: z.record(z.string(), z.string()).nullable().optional(),
});

const azureConfigSchema = z.object({
  endpoint: z.string().min(1),
  apiKey: z.string().optional(),
  deployments: z.array(azureDeploymentSchema).min(1, 'deployments must be a non-empty array'),
});

const copilotConfigSchema = z.object({
  githubToken: z.string().min(1),
  accountType: z.enum(['individual', 'business', 'enterprise']),
  user: z.object({
    login: z.string(),
    avatar_url: z.string(),
    name: z.string().nullable(),
    id: z.number(),
  }),
});

// --- auth ---

export const authLoginBody = z.object({
  key: z.string().min(1),
});

// --- api keys ---

export const createKeyBody = z.object({
  name: z.string().min(1),
});

// upstream_ids: null = inherit global order, non-empty unique string[] = whitelist.
// Empty array is rejected because a key that allows zero upstreams cannot serve
// any model and the UI has no affordance to express that intent.
const upstreamIdsValueSchema = z.array(z.string().min(1))
  .min(1, 'upstream_ids must contain at least one upstream id; use null for Default mode')
  .refine(arr => new Set(arr).size === arr.length, { message: 'upstream_ids contains duplicates' })
  .nullable();

export const updateKeyBody = z.object({
  name: z.string().min(1).optional(),
  upstream_ids: upstreamIdsValueSchema.optional(),
});

// --- upstreams ---

const upstreamBaseFields = {
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  flag_overrides: flagOverridesSchema.optional(),
};

// Create accepts a discriminated union on `provider` so frontends get
// shape-specific autocomplete on `config`. Copilot upstreams normally
// originate from the device-flow poll endpoint, but POST also accepts them
// for the import flow. `enabled` and `sort_order` are optional — the handler
// defaults them to `true` and `nextSortOrder()` respectively when omitted.
export const createUpstreamBody = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('custom'), ...upstreamBaseFields, config: customConfigSchema }),
  z.object({ provider: z.literal('azure'), ...upstreamBaseFields, config: azureConfigSchema }),
  z.object({ provider: z.literal('copilot'), ...upstreamBaseFields, config: copilotConfigSchema }),
]);

// Update is provider-agnostic: provider is read from the existing record, and
// the config shape is validated by the handler against that record's provider.
// Patches omit fields they don't change; `config` may be a partial patch object
// that the handler shallow-merges with the existing config.
//
// `provider` may appear in the body so the handler can return the canonical
// "provider cannot be changed" 400 when a caller tries to switch providers;
// without this field the schema would silently strip it and the API would
// look like it had accepted the change.
export const updateUpstreamBody = z.object({
  provider: z.enum(['custom', 'azure', 'copilot']).optional(),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  flag_overrides: flagOverridesSchema.optional(),
  config: z.unknown().optional(),
});

// --- copilot device flow ---

export const copilotAuthPollBody = z.object({
  device_code: z.string().min(1),
});

// --- search config ---

export const searchConfigSchema = z.object({
  provider: z.enum(['disabled', 'tavily', 'microsoft-grounding']),
  tavily: z.object({ apiKey: z.string() }),
  microsoftGrounding: z.object({ apiKey: z.string() }),
});

// --- data transfer ---

export const importBody = z.object({
  version: z.literal(2, { error: 'version must be 2' }),
  mode: z.enum(['merge', 'replace'], { error: "mode must be 'merge' or 'replace'" }),
  data: z.unknown().optional(),
});

export const exportQuery = z.object({
  include_performance: z.string().optional(),
});

// --- query strings (token-usage, search-usage, performance) ---
//
// start/end stay optional in the schema (rather than `.min(1)`) so the
// handler can return the canonical "start and end query parameters are
// required" message its tests assert on. The schema's job here is to
// inform the RPC client of the available fields, not duplicate the
// required-ness check.

const usageBaseQuery = {
  start: z.string().optional(),
  end: z.string().optional(),
  key_id: z.string().optional(),
  include_key_metadata: z.string().optional(),
};

export const tokenUsageQuery = z.object(usageBaseQuery);
export const searchUsageQuery = z.object({
  ...usageBaseQuery,
  provider: z.string().optional(),
});

export const performanceQuery = z.object({
  ...usageBaseQuery,
  metric_scope: z.enum(['request_total', 'upstream_success']).optional(),
  group_by: z.enum(['none', 'keyId', 'model', 'sourceApi', 'targetApi', 'runtimeLocation']).optional(),
  bucket: z.enum(['hour', '4h', '8h', 'day', 'all']).optional(),
  timezone_offset_minutes: z.string().optional(),
});
