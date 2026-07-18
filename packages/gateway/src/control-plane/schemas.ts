// Centralized zod schemas for every control-plane route that carries a JSON
// body or non-trivial query string. Two purposes:
//
// 1. Runtime guard — zValidator rejects malformed input before it reaches a
//    handler, with a 400 + `{ error: msg }` response.
//
// 2. Type inference for the Hono RPC client — `hc<AppType>(...)` reads the
//    schemas attached to each route to type `$post({ json })`, `$patch({ json })`,
//    `$get({ query })`, etc. The frontend therefore gets autocomplete on the
//    request shape without a separate codegen step.
//
// Deep upstream-config validation (e.g. Azure URL hostname rules, custom
// pathOverrides and modelsFetch.endpoint URL parsing, per-model endpoint path
// checks) intentionally stays in the handler functions — they own the
// canonical error messages and downstream cache invalidation. The schemas
// here describe the shape the dashboard sends.

import { z } from 'zod';

import { normalizeDisabledPublicModelIds } from '../repo/disabled-public-models.ts';
import { CUSTOM_API_KEY_MAX_LENGTH, KEY_SOURCES } from '../shared/api-key-tokens.ts';
import { type FlagOverrides, MODEL_PREFIX_MAX_LENGTH, MODEL_PREFIX_REGEX, normalizeUpstreamColor, parseFlagOverridesWire } from '@floway-dev/provider';

// --- shared atoms ---

// Reuse the runtime parseFlagOverridesWire so unknown-id and type errors
// carry the canonical messages. z.unknown() → transform keeps the
// schema-validated output typed as FlagOverrides for the RPC client.
const flagOverridesSchema = z.unknown().transform((value, ctx): FlagOverrides => {
  try {
    return parseFlagOverridesWire(value);
  } catch (e) {
    ctx.issues.push({ code: 'custom', message: e instanceof Error ? e.message : String(e), input: value });
    return z.NEVER;
  }
});

// Like flag_overrides, the disabled-models field normalizes at the API edge so a
// create/update response echoes exactly what gets persisted (trimmed, de-duped).
// There is no id allowlist to enforce — any string is a legal public model id —
// so this only trims and de-dupes rather than rejecting unknown ids.
const disabledPublicModelIdsSchema = z.array(z.string()).transform(normalizeDisabledPublicModelIds);

// The structured endpoint capability map, shared by per-model config and the
// custom upstream-level fallback. A present key declares the endpoint is served.
// One concept, all endpoints — the runtime validators enforce presence/emptiness
// rules.
const modelEndpointsSchema = z.object({
  completions: z.object({}).optional(),
  chatCompletions: z.object({}).optional(),
  responses: z.object({}).optional(),
  messages: z.object({}).optional(),
  embeddings: z.object({}).optional(),
  imagesGenerations: z.object({}).optional(),
  imagesEdits: z.object({}).optional(),
});

const pricingDimensionShape = {
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  input_cache_read: z.number().nonnegative().optional(),
  input_cache_write: z.number().nonnegative().optional(),
  input_cache_write_1h: z.number().nonnegative().optional(),
  input_image: z.number().nonnegative().optional(),
  output_image: z.number().nonnegative().optional(),
};

// Modality arrays: both input and output require at least one entry and
// deduplicate via transform. Input additionally requires 'text' to be present
// (a multimodal model must accept text); output has no such constraint (an
// image-generation model may emit only images).
const modalityArraySchema = z.array(z.enum(['text', 'image']))
  .min(1)
  .transform(arr => Array.from(new Set(arr)));

const inputModalityArraySchema = modalityArraySchema
  .refine(arr => arr.includes('text'), { message: "must include 'text'" });

const modalitiesSchema = z.object({
  input: inputModalityArraySchema,
  output: modalityArraySchema,
});

const effortSchema = z.object({
  supported: z.array(z.string().min(1))
    .min(1)
    .transform(arr => Array.from(new Set(arr))),
  default: z.string().min(1),
}).refine(
  r => r.supported.includes(r.default),
  { message: 'effort.default must appear in effort.supported' },
);

const budgetTokensSchema = z.object({
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().nonnegative().optional(),
}).refine(
  r => r.min === undefined || r.max === undefined || r.max >= r.min,
  { message: 'budget_tokens.max must be >= budget_tokens.min' },
);

const reasoningSchema = z.object({
  effort: effortSchema.optional(),
  budget_tokens: budgetTokensSchema.optional(),
  adaptive: z.literal(true).optional(),
  mandatory: z.literal(true).optional(),
}).refine(
  r => r.effort !== undefined || r.budget_tokens !== undefined || r.adaptive !== undefined || r.mandatory !== undefined,
  { message: 'reasoning must have at least one of effort, budget_tokens, adaptive, mandatory' },
);

const chatSchema = z.object({
  modalities: modalitiesSchema.optional(),
  reasoning: reasoningSchema.optional(),
});

// Shared limits shape used by both the upstream-model schema and the
// alias's announced-metadata override.
const limitsSchema = z.object({
  max_context_window_tokens: z.number().optional(),
  max_prompt_tokens: z.number().optional(),
  max_output_tokens: z.number().optional(),
});

// Mirrors the runtime UpstreamModelConfig in @floway-dev/provider.
// Azure and custom upstreams share this per-model entry; the canonical
// per-model endpoint validation lives in the runtime validator.
const upstreamModelSchema = z.object({
  upstreamModelId: z.string().min(1),
  publicModelId: z.string().optional(),
  kind: z.enum(['chat', 'embedding', 'image']).optional(),
  endpoints: modelEndpointsSchema,
  display_name: z.string().optional(),
  pricing: z.object({
    entries: z.array(z.object({
      selector: z.record(z.string(), z.unknown()).optional(),
      rates: z.object(pricingDimensionShape).strict(),
    }).strict()).min(1),
  }).strict().optional(),
  flagOverrides: flagOverridesSchema.optional(),
  limits: limitsSchema.optional(),
  chat: chatSchema.optional(),
}).refine(
  m => m.chat === undefined || m.kind === undefined || m.kind === 'chat',
  { message: "chat metadata only allowed when kind === 'chat'", path: ['chat'] },
);

const customConfigSchema = z.object({
  baseUrl: z.string().min(1),
  authStyle: z.enum(['bearer', 'anthropic', 'none']),
  // Structured capability map — the runtime parser permits an empty map for
  // an upstream serving only kind-derived models.
  endpoints: modelEndpointsSchema,
  // Optional because edit-mode PATCH omits it to keep the stored secret;
  // the runtime parser enforces presence vs. authStyle invariants.
  apiKey: z.string().optional(),
  // PATCH passes `null` to explicitly clear pathOverrides; nullable() keeps
  // that escape hatch.
  pathOverrides: z.record(z.string(), z.string()).nullable().optional(),
  // Live upstream /models fetch. `endpoint` parsing happens in the runtime.
  modelsFetch: z.object({ enabled: z.boolean(), endpoint: z.string().optional() }).optional(),
  // Statically configured per-model overrides merged with the live fetch.
  models: z.array(upstreamModelSchema).optional(),
});

const azureConfigSchema = z.object({
  endpoint: z.string().min(1),
  apiKey: z.string().optional(),
  models: z.array(upstreamModelSchema).min(1, 'models must be a non-empty array'),
});

const ollamaConfigSchema = z.object({
  baseUrl: z.string().min(1),
  // Optional: required against ollama.com, typically absent for a private
  // daemon. PATCH passes `null` to explicitly clear it.
  apiKey: z.string().nullable().optional(),
  models: z.array(upstreamModelSchema).optional(),
});

// --- auth ---

// Cap PBKDF2 input length: 1024 bytes — well above any real passphrase. The
// CPU cost dependency on length is sub-linear past SHA-256's 64-byte block
// (oversize keys are pre-hashed once before the iteration loop), but the
// JSON-parse + zod + pre-hash work is still worth bounding.
const passwordSchema = z.string().min(1).max(1024);

// Both fields are allowed empty so the blank-username login path (ADMIN_KEY
// match, or the dev-only passwordless shortcut when ADMIN_KEY is unset)
// passes validation; the login handler dispatches on the empty values.
export const authLoginBody = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_.\-]{0,64}$/, 'username must be 0-64 chars of [A-Za-z0-9_.-] (empty for ADMIN_KEY login)'),
  password: z.string().max(1024),
});

// --- users ---

export const USERNAME_PATTERN = /^[a-zA-Z0-9_.\-]{1,64}$/;

const usernameSchema = z.string().regex(USERNAME_PATTERN, 'username must be 1-64 chars of [A-Za-z0-9_.-]');

// upstream_ids: null = inherit global order, non-empty unique string[] = whitelist.
// Empty array is rejected because zero upstreams cannot serve any model.
const upstreamIdsValueSchema = z.array(z.string().min(1))
  .min(1, 'Select at least one upstream, or turn off the override to allow all.')
  .refine(arr => new Set(arr).size === arr.length, { message: 'upstreamIds contains duplicates' })
  .nullable();

export const createUserBody = z.object({
  username: usernameSchema,
  password: passwordSchema,
  isAdmin: z.boolean().optional(),
  upstreamIds: upstreamIdsValueSchema.optional(),
  canViewGlobalTelemetry: z.boolean().optional(),
});

export const updateUserBody = z.object({
  username: usernameSchema.optional(),
  password: passwordSchema.optional(),
  isAdmin: z.boolean().optional(),
  upstreamIds: upstreamIdsValueSchema.optional(),
  canViewGlobalTelemetry: z.boolean().optional(),
});

export const changeOwnPasswordBody = z.object({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
});

// --- api keys ---

// `dump_retention_seconds`: null disables capture; a positive integer is the
// per-record TTL in seconds. Zero would mean "capture but expire immediately"
// which has no sensible behavior, so it is rejected at the schema layer.
// The 10-year upper bound rejects absurd inputs as a clean validation error
// rather than letting them through as de-facto "never expire".
export const DUMP_RETENTION_MAX_SECONDS = 10 * 365 * 24 * 60 * 60;
const dumpRetentionSecondsSchema = z.number().int().positive().max(DUMP_RETENTION_MAX_SECONDS).nullable();

// `key_source` picks how the raw key on this create/rotate request is
// produced: 'generate' means the gateway mints an sk-...T3BlbkFJ... token
// for this write; 'custom' means the request carries the token verbatim in
// `custom_key`. The choice is per-call — the shape is not persisted, and a
// later rotate is free to switch styles without any state on the row.
const keySourceShape = {
  key_source: z.enum(KEY_SOURCES).optional(),
  custom_key: z.string().max(CUSTOM_API_KEY_MAX_LENGTH).optional(),
};

export const createKeyBody = z.object({
  name: z.string().min(1),
  upstream_ids: upstreamIdsValueSchema.optional(),
  dump_retention_seconds: dumpRetentionSecondsSchema.optional(),
  ...keySourceShape,
});

export const rotateKeyBody = z.object(keySourceShape);

export const updateKeyBody = z.object({
  name: z.string().min(1).optional(),
  upstream_ids: upstreamIdsValueSchema.optional(),
  dump_retention_seconds: dumpRetentionSecondsSchema.optional(),
});

// --- upstreams ---

// Per-upstream proxy fallback list. Each entry is an object with a required
// `id` (a proxy id known to the proxies repo, or a built-in direct transport)
// and an optional `colos` whitelist
// of location tags (Cloudflare colos / the Node `RUNTIME_LOCATION` env
// var). `colos` is intentionally not cross-checked against a known-colo list
// — Node `RUNTIME_LOCATION` is free-form and CF adds new colos we haven't
// enumerated. When present it must be non-empty: stored and wire shapes stay
// symmetric, so "all colos" is always the absent field.
const proxyFallbackListSchema = z.array(z.object({
  id: z.string().min(1),
  colos: z.array(z.string().min(1)).min(1).optional(),
}));

// Per-upstream model name prefix policy. `null` clears the policy (the upstream
// publishes and accepts bare ids only). The handler then funnels the shape
// through `normalizeModelPrefix` so the persisted form matches what the
// runtime expects — order canonicalised, and `listed` entries outside
// `addressable` are rejected as a contract violation.
const addressableFormSchema = z.enum(['unprefixed', 'prefixed']);

const modelPrefixSchema = z.object({
  prefix: z.string().max(MODEL_PREFIX_MAX_LENGTH).regex(MODEL_PREFIX_REGEX, 'must end with / and use letters, digits, dot, dash, underscore, or slash'),
  addressable: z.array(addressableFormSchema).nonempty(),
  listed: z.array(addressableFormSchema),
}).nullable();

// Per-upstream badge color override. `null` inherits the frontend's kind
// default. Delegates parsing entirely to `normalizeUpstreamColor` so the
// wire accept-rules stay in one place (`@floway-dev/provider/model`);
// widening / narrowing the accepted forms — new preset, alpha hex, etc.
// — is a one-file change. The transform surfaces the normalizer's throw
// as a Zod issue so the client-side error shape stays consistent with
// the sibling flagOverridesSchema.
const upstreamColorSchema = z.unknown().transform((value, ctx) => {
  try {
    return normalizeUpstreamColor(value);
  } catch (e) {
    ctx.issues.push({ code: 'custom', message: e instanceof Error ? e.message : String(e), input: value });
    return z.NEVER;
  }
});

const upstreamBaseFields = {
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  flag_overrides: flagOverridesSchema.optional(),
  disabled_public_model_ids: disabledPublicModelIdsSchema.optional(),
  proxy_fallback_list: proxyFallbackListSchema.optional(),
  model_prefix: modelPrefixSchema.optional(),
  color: upstreamColorSchema.optional(),
};

// Create accepts a discriminated union on `kind` for per-provider config
// validation. `enabled` and `sort_order` are optional — the handler
// defaults them to `true` and to one past the current max sort order
// when omitted.
export const createUpstreamBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('custom'), ...upstreamBaseFields, config: customConfigSchema }),
  z.object({ kind: z.literal('azure'), ...upstreamBaseFields, config: azureConfigSchema }),
  // Copilot / Codex / Claude Code carry OAuth-derived credentials that the
  // create page populates via the corresponding OAuth-exchange helper
  // before Save. `state` is accepted here as an opaque payload; the
  // per-kind assertXxxUpstreamRecord in the handler narrows it once the
  // request lands.
  z.object({ kind: z.literal('copilot'), ...upstreamBaseFields, config: z.unknown(), state: z.unknown().optional() }),
  z.object({ kind: z.literal('codex'), ...upstreamBaseFields, config: z.unknown(), state: z.unknown().optional() }),
  z.object({ kind: z.literal('claude-code'), ...upstreamBaseFields, config: z.unknown(), state: z.unknown().optional() }),
  z.object({ kind: z.literal('ollama'), ...upstreamBaseFields, config: ollamaConfigSchema }),
]);

// Update is kind-agnostic: kind is read from the existing record, and
// the config shape is validated by the handler against that record's kind.
// Patches omit fields they don't change; `config` may be a partial patch object
// that the handler shallow-merges with the existing config.
//
// `kind` may appear in the body so the handler can return the canonical
// "kind cannot be changed" 400 when a caller tries to switch kinds;
// without this field the schema would silently strip it and the API would
// look like it had accepted the change.
export const updateUpstreamBody = z.object({
  kind: z.enum(['custom', 'azure', 'copilot', 'codex', 'claude-code', 'ollama']).optional(),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  flag_overrides: flagOverridesSchema.optional(),
  disabled_public_model_ids: disabledPublicModelIdsSchema.optional(),
  proxy_fallback_list: proxyFallbackListSchema.optional(),
  model_prefix: modelPrefixSchema.optional(),
  color: upstreamColorSchema.optional(),
  // Patches only carry field diffs, not per-kind shape validation — the
  // handler dispatches on the existing row's kind and enforces the shape
  // there (Copilot/Codex/Claude Code reject a config patch outright, since
  // OAuth-managed slices belong to the action endpoints; the rest run
  // through `assertXxxUpstreamRecord`). `z.record(z.unknown())` blocks
  // primitives / arrays / null from reaching the handler as `config`.
  config: z.record(z.string(), z.unknown()).optional(),
});

// Shared envelope for the record-body action contract used by every
// action endpoint (OAuth exchange/refresh, quota, probe, list-models,
// etc.). The client posts its full draft record; the server reads only
// fields relevant to the specific action (credentials in config/state,
// proxy_fallback_list for routing) and produces a targeted patch. Kind
// and id validation is deferred to the handler so a single schema
// serves every provider.
export const upstreamRecordEnvelope = z.object({
  id: z.string(),
  kind: z.string(),
  config: z.unknown(),
  state: z.unknown(),
  proxy_fallback_list: proxyFallbackListSchema.optional(),
}).passthrough();

// The bare envelope contract — every action endpoint that takes no extras
// beyond `record` (refresh, probe, quota, list-models) shares this shape.
const recordOnlyBody = z.object({ record: upstreamRecordEnvelope });

export const copilotOauthDeviceLoginPollBody = z.object({
  record: upstreamRecordEnvelope,
  deviceCode: z.string().min(1),
});

export const copilotQuotaBody = recordOnlyBody;

// --- codex OAuth (record-body contract) ---
//
// PKCE state is fully SPA-held: the dashboard mints `{verifier, challenge,
// state}` in the browser via Web Crypto, stores `{verifier, state}` in
// sessionStorage, and posts `challenge + state` here so the server can stamp
// them into the upstream's authorize URL. The server never sees the
// verifier until the callback comes back as `{code, verifier}` on exchange.

export const codexOauthAuthorizeUrlBody = z.object({
  record: upstreamRecordEnvelope,
  challenge: z.string().min(1),
  state: z.string().min(1),
});

export const codexOauthExchangeBody = z.object({
  record: upstreamRecordEnvelope,
  auth_json: z.string().min(1).optional(),
  callback: z.object({
    code: z.string().min(1),
    verifier: z.string().min(1),
  }).optional(),
}).refine(
  b => (b.auth_json !== undefined) !== (b.callback !== undefined),
  { message: 'Provide exactly one of auth_json or callback' },
);

export const codexOauthRefreshBody = recordOnlyBody;

// --- claude-code OAuth + setup-token + probe (record-body contract) ---

// Shared by claude-code OAuth + Setup-Token callbacks.
const oauthCallbackSchema = z.object({
  code: z.string().min(1),
  verifier: z.string().min(1),
  state: z.string().min(1),
});

export const claudeCodeOauthAuthorizeUrlBody = z.object({
  record: upstreamRecordEnvelope,
  challenge: z.string().min(1),
  state: z.string().min(1),
});

export const claudeCodeOauthExchangeBody = z.object({
  record: upstreamRecordEnvelope,
  credentials_json: z.string().min(1).optional(),
  callback: oauthCallbackSchema.optional(),
}).refine(
  b => (b.credentials_json !== undefined) !== (b.callback !== undefined),
  { message: 'Provide exactly one of credentials_json or callback' },
);

export const claudeCodeOauthRefreshBody = recordOnlyBody;

export const claudeCodeSetupTokenAuthorizeUrlBody = z.object({
  record: upstreamRecordEnvelope,
  challenge: z.string().min(1),
  state: z.string().min(1),
});

export const claudeCodeSetupTokenExchangeBody = z.object({
  record: upstreamRecordEnvelope,
  callback: oauthCallbackSchema,
});

export const claudeCodeProbeBody = recordOnlyBody;

// Unified live-model listing for both create-time preview and edit-time
// refresh. Custom returns the raw upstream row (dashboard translates
// through the draft's endpoints); every other kind returns the fully
// projected UpstreamModelConfig catalog.
export const listModelsBody = recordOnlyBody;

// --- proxies ---
//
// Proxy URLs accept the URI schemes parsed by `parseProxyUri` in
// @floway-dev/proxy: http, https, socks5, ss, trojan, vless. `ss://`
// carries both the legacy AEAD-2018 and 2022-blake3 ciphersuites
// (disambiguated by userinfo shape), and `vless://?security=reality` routes
// to REALITY. We don't pre-validate the URI shape in zod — the handler runs
// `parseProxyUri` and returns its error message verbatim so the operator
// sees the canonical "unsupported scheme" / "missing password" feedback.

// Per-proxy dial-stage timeout. Capped at 600s (10min): an operator
// override beyond that would let a single dead proxy stall the fallback
// chain past any reasonable client deadline.
const dialTimeoutSecondsSchema = z.number().int().min(1).max(600);

export const createProxyBody = z.object({
  name: z.string().min(1).max(200),
  url: z.string().min(1),
  dial_timeout_seconds: dialTimeoutSecondsSchema.nullable().optional(),
});

export const updateProxyBody = z.object({
  name: z.string().min(1).max(200).optional(),
  url: z.string().min(1).optional(),
  // nullable so the operator can clear back to the gateway-wide default;
  // absent vs. null is meaningful in PATCH.
  dial_timeout_seconds: dialTimeoutSecondsSchema.nullable().optional(),
});

// `url` carries the live URL the operator currently has in the editor so the
// test runs against the in-progress form before any persistence; the endpoint
// validates the URL parses but does not load a stored row. `anchor` names a
// known IP-echo HTTPS service — three distinct anchors (ipify, AWS checkip,
// ident.me v6-only) so an operator debugging "wrong egress IP" or "v4 vs v6
// routing" can rerun the test against a different anchor without needing to
// teach the gateway a new endpoint.
export const testProxyBody = z.object({
  url: z.string().min(1),
  dial_timeout_seconds: dialTimeoutSecondsSchema.nullable().optional(),
  anchor: z.enum(['ipify', 'aws', 'ident.me-v6']).optional(),
});

// `upstream_id` narrows the reset to a single (proxy, upstream) pair; without
// it the handler clears every backoff row for the proxy. `min(1)` rejects
// `""` at the boundary — the handler treats undefined as "clear all" and
// would otherwise read the empty string as a real id, deleting nothing and
// reporting success on malformed input.
export const resetBackoffBody = z.object({
  upstream_id: z.string().min(1).optional(),
});

// --- search config ---

export const searchConfigSchema = z.object({
  provider: z.enum(['disabled', 'tavily', 'microsoft-grounding', 'jina']),
  tavily: z.object({ apiKey: z.string() }),
  microsoftGrounding: z.object({ apiKey: z.string() }),
  jina: z.object({ apiKey: z.string() }),
  passthroughOpenAiSearch: z.object({
    enabled: z.boolean(),
    upstreamId: z.string(),
    model: z.string(),
  }),
}).superRefine((config, ctx) => {
  if (!config.passthroughOpenAiSearch.enabled) return;
  if (config.passthroughOpenAiSearch.upstreamId.trim() === '') {
    ctx.addIssue({ code: 'custom', path: ['passthroughOpenAiSearch', 'upstreamId'], message: 'Select an upstream' });
  }
  if (config.passthroughOpenAiSearch.model.trim() === '') {
    ctx.addIssue({ code: 'custom', path: ['passthroughOpenAiSearch', 'model'], message: 'Select a model' });
  }
});

// --- model aliases ---

// Per-target chat rules. Field names mirror the IR slot each value overlays.
// Values forward verbatim — no capability narrowing here, so an operator
// can drive a feature the catalog hasn't advertised yet. All open-string
// fields (`effort` + `summary` on the reasoning sub-block below,
// `verbosity` + `serviceTier` on the outer rules schema) accept any
// string for the same reason; the dashboard pins canonical presets as
// combobox suggestions.
const chatAliasReasoningSchema = z.object({
  effort: z.string().min(1).optional(),
  budget_tokens: z.number().int().nonnegative().optional(),
  adaptive: z.boolean().optional(),
  summary: z.string().min(1).optional(),
}).strict().refine(
  // `adaptive` and a pinned `budget_tokens` are mutually exclusive on the
  // Messages wire — `thinking.type` is one of `adaptive` or `enabled`, and
  // only the `enabled` branch carries a `budget_tokens`. Storing both on the
  // same rule would silently discard the budget at overlay time.
  r => !(r.adaptive === true && r.budget_tokens !== undefined),
  {
    message: 'reasoning.adaptive=true cannot be combined with reasoning.budget_tokens — adaptive mode auto-determines the budget',
    path: ['budget_tokens'],
  },
);

const chatAliasRulesSchema = z.object({
  reasoning: chatAliasReasoningSchema.optional(),
  verbosity: z.string().min(1).optional(),
  serviceTier: z.string().min(1).optional(),
}).strict();

// Rules are validated against the alias-level kind in the superRefine pass
// below — chat-kind aliases accept ChatAliasRules; other kinds require an
// empty object. Each target_model_id is opaque (no `/` semantics in the
// alias layer), so the only structural check is non-emptiness.
const aliasTargetSchema = z.object({
  target_model_id: z.string().min(1),
  rules: z.record(z.string(), z.unknown()),
});

// Operator override for an alias's announced /v1/models payload. Both
// sub-fields are independently optional, and the listing pipeline falls
// back to the rule-aware automatic computation for any TOP-LEVEL
// sub-block (`limits` / `chat`) the operator did not provide — a present
// sub-block replaces the computed counterpart wholesale, not per-leaf.
// `chatSchema` and `limitsSchema` are the same shapes the upstream-model
// surface validates, so the override carries the catalog's full
// vocabulary.
const announcedMetadataSchema = z.object({
  limits: limitsSchema.optional(),
  chat: chatSchema.optional(),
});

const aliasBaseShape = {
  name: z.string().min(1),
  kind: z.enum(['chat', 'embedding', 'image']),
  selection: z.enum(['random', 'first-available']),
  display_name: z.string().min(1).nullable(),
  visible_in_models_list: z.boolean(),
  targets: z.array(aliasTargetSchema).min(1),
  announced_metadata: announcedMetadataSchema.nullable(),
  sort_order: z.number().int().optional(),
};

const aliasBodyCore = z.object(aliasBaseShape);

// superRefine cross-validates each target's `rules` against the alias-level
// kind. Chat: parse through `chatAliasRulesSchema` and surface the inner
// issue verbatim. Embedding / image: the slot must be `{}` until a future
// schema lands. `announced_metadata.chat` is bound to the same invariant:
// a chat block on a non-chat alias would land on the InternalModel row and
// leak an incoherent `chat: {...}` sidecar onto `/v1/models` for a row
// whose `kind` says it does not carry one.
const aliasBodyRulesRefinement = (
  value: z.infer<typeof aliasBodyCore>,
  ctx: z.core.$RefinementCtx,
): void => {
  value.targets.forEach((target, index) => {
    if (value.kind === 'chat') {
      const parsed = chatAliasRulesSchema.safeParse(target.rules);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.issues.push({
            code: 'custom',
            message: issue.message,
            path: ['targets', index, 'rules', ...issue.path],
            input: target.rules,
          });
        }
      }
      return;
    }
    if (Object.keys(target.rules).length !== 0) {
      ctx.issues.push({
        code: 'custom',
        message: `rules must be empty for kind=${value.kind}`,
        path: ['targets', index, 'rules'],
        input: target.rules,
      });
    }
  });
  if (value.kind !== 'chat' && value.announced_metadata?.chat !== undefined) {
    ctx.issues.push({
      code: 'custom',
      message: `announced_metadata.chat is only allowed for kind='chat' aliases`,
      path: ['announced_metadata', 'chat'],
      input: value.announced_metadata.chat,
    });
  }
};

// Create and update share the same body shape — the difference is operational:
// create rejects PK collisions, update reads the path `:name` as the old name
// and treats a different `body.name` as a rename. Splitting them keeps the
// type names self-documenting at the RPC-client surface.
export const createAliasBody = aliasBodyCore.superRefine(aliasBodyRulesRefinement);
export const updateAliasBody = aliasBodyCore.superRefine(aliasBodyRulesRefinement);

// --- data transfer ---

export const importBody = z.object({
  version: z.literal(11, { error: 'version must be 11 — older export formats are not supported; re-export from the current deployment' }),
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
  include_user_metadata: z.string().optional(),
  view: z.enum(['all-by-user', 'self-by-key']).optional(),
};

export const tokenUsageQuery = z.object(usageBaseQuery);

// Dashboard `/api/models` accepts two query knobs. `aliases=false` skips the
// alias-merge pass — the alias edit dialog and shadow detection need the
// raw real-model set. `include_unlisted=true` extends the payload with the
// addressable-but-not-listed surface (prefix-form alternates, Copilot
// variant ids, provider-side redirects), so the alias dialog combobox sees
// every id the data-plane resolver would accept.
export const modelsQuery = z.object({
  aliases: z.enum(['true', 'false']).optional(),
  include_unlisted: z.enum(['true', 'false']).optional(),
});

export const searchUsageQuery = z.object({
  ...usageBaseQuery,
  provider: z.string().optional(),
});

export const performanceQuery = z.object(usageBaseQuery).omit({ include_key_metadata: true, include_user_metadata: true }).extend({
  group_by: z.enum(['keyId', 'userId', 'model', 'upstream', 'operation', 'runtimeLocation']).optional(),
  bucket: z.enum(['hour', '4h', '8h', 'day', 'all']).optional(),
  timezone_offset_minutes: z.string().optional(),
  // Cross-cutting filters applied to raw records before aggregation. Each is
  // a single value (dashboard dropdown is single-select); combining filters
  // is AND.
  filter_model: z.string().optional(),
  filter_upstream: z.string().optional(),
  filter_operation: z.string().optional(),
  filter_runtime_location: z.string().optional(),
  // User ids are auto-increment starting at 1, so zero and leading-zero forms
  // can never resolve and are rejected up front rather than silently returning
  // an empty result.
  filter_user_id: z.union([z.literal(''), z.string().regex(/^[1-9]\d*$/, 'filter_user_id must be a positive integer')]).optional(),
  filter_key_id: z.string().optional(),
});
