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
import { OPTIONAL_FLAGS, parseFlagOverridesWire } from '@floway-dev/provider';

// --- shared atoms ---

const knownFlagIds = new Set<string>(OPTIONAL_FLAGS.map(f => f.id));

// Reuse the runtime parseFlagOverridesWire so unknown-id and type errors
// carry the canonical messages. z.unknown() → transform keeps the
// schema-validated output typed as Record<string, boolean> for the RPC client.
const flagOverridesSchema = z.unknown().transform((value, ctx): Record<string, boolean> => {
  try {
    return parseFlagOverridesWire(value);
  } catch (e) {
    ctx.issues.push({ code: 'custom', message: e instanceof Error ? e.message : String(e), input: value });
    return z.NEVER;
  }
});

const flagOverrideValuesSchema = z.record(z.string(), z.boolean()).refine(
  overrides => Object.keys(overrides).every(id => knownFlagIds.has(id)),
  'Unknown flag id in model flag overrides',
);

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

// Shared between base pricing and per-tier overlays so the two always carry
// the same dimension set.
const pricingDimensionShape = {
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  input_cache_read: z.number().nonnegative().optional(),
  input_cache_write: z.number().nonnegative().optional(),
  input_cache_write_1h: z.number().nonnegative().optional(),
  input_image: z.number().nonnegative().optional(),
  output_image: z.number().nonnegative().optional(),
};

// Mirrors the runtime UpstreamModelConfig in @floway-dev/provider.
// Azure and custom upstreams share this per-model entry; the canonical
// per-model endpoint validation lives in the runtime validator.
const upstreamModelSchema = z.object({
  upstreamModelId: z.string().min(1),
  publicModelId: z.string().optional(),
  kind: z.enum(['chat', 'embedding', 'image']).optional(),
  endpoints: modelEndpointsSchema,
  display_name: z.string().optional(),
  cost: z.object({
    ...pricingDimensionShape,
    // See ModelPricing.tiers in @floway-dev/protocols/common for semantics.
    tiers: z.record(
      z.string().min(1),
      z.object(pricingDimensionShape).refine(
        t => Object.values(t).some(v => v !== undefined),
        { message: 'tier overlay must declare at least one rate' },
      ),
    ).optional(),
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

const copilotConfigSchema = z.object({
  githubToken: z.string().min(1),
  user: z.object({
    login: z.string(),
    avatar_url: z.string(),
    name: z.string().nullable(),
    id: z.number(),
  }),
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

// Username is allowed empty so the ADMIN_KEY-only login path passes
// validation; the login handler dispatches on the empty value.
export const authLoginBody = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_.\-]{0,64}$/, 'username must be 0-64 chars of [A-Za-z0-9_.-] (empty for ADMIN_KEY login)'),
  password: passwordSchema,
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

export const createKeyBody = z.object({
  name: z.string().min(1),
  upstream_ids: upstreamIdsValueSchema.optional(),
});

export const updateKeyBody = z.object({
  name: z.string().min(1).optional(),
  upstream_ids: upstreamIdsValueSchema.optional(),
  dump_retention_seconds: dumpRetentionSecondsSchema.optional(),
});

// --- upstreams ---

// Per-upstream proxy fallback list. Each entry is an object with a required
// `id` (a proxy id known to the proxies repo, or the literal `'direct'`
// sentinel meaning "dial without a proxy") and an optional `colos` whitelist
// of location tags (Cloudflare colos / the Node `RUNTIME_LOCATION` env
// var). `colos` is intentionally not cross-checked against a known-colo list
// — Node `RUNTIME_LOCATION` is free-form and CF adds new colos we haven't
// enumerated. When present it must be non-empty: stored and wire shapes stay
// symmetric, so "all colos" is always the absent field.
const proxyFallbackListSchema = z.array(z.object({
  id: z.string().min(1),
  colos: z.array(z.string().min(1)).min(1).optional(),
}));

const upstreamBaseFields = {
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  flag_overrides: flagOverridesSchema.optional(),
  disabled_public_model_ids: disabledPublicModelIdsSchema.optional(),
  proxy_fallback_list: proxyFallbackListSchema.optional(),
};

// Create accepts a discriminated union on `provider` for per-provider config
// validation. Copilot upstreams normally originate from the device-flow poll
// endpoint, but POST also accepts them for the import flow. `enabled` and
// `sort_order` are optional — the handler defaults them to `true` and
// `nextSortOrder()` respectively when omitted.
//
// `codex` and `claude-code` are listed here so the handler can return the
// canonical "use POST /api/upstreams/<provider>-import" 400 instead of the
// cryptic zod "invalid discriminator value" message. The `config` slot is
// `unknown()` because the real config is derived from the OAuth flow, not
// from anything posted against this endpoint.
export const createUpstreamBody = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('custom'), ...upstreamBaseFields, config: customConfigSchema }),
  z.object({ provider: z.literal('azure'), ...upstreamBaseFields, config: azureConfigSchema }),
  z.object({ provider: z.literal('copilot'), ...upstreamBaseFields, config: copilotConfigSchema }),
  z.object({ provider: z.literal('codex'), ...upstreamBaseFields, config: z.unknown() }),
  z.object({ provider: z.literal('claude-code'), ...upstreamBaseFields, config: z.unknown() }),
  z.object({ provider: z.literal('ollama'), ...upstreamBaseFields, config: ollamaConfigSchema }),
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
  provider: z.enum(['custom', 'azure', 'copilot', 'codex', 'claude-code', 'ollama']).optional(),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  flag_overrides: flagOverridesSchema.optional(),
  disabled_public_model_ids: disabledPublicModelIdsSchema.optional(),
  proxy_fallback_list: proxyFallbackListSchema.optional(),
  config: z.unknown().optional(),
});

// Draft /models browse: accepts an in-progress upstream config so callers can
// fetch the upstream's live model list before saving. `id` is present in
// edit mode so the handler can substitute the stored secret when the secret
// is left blank ("keep the stored secret"). Discriminated by `provider` so
// each provider's draft preview surfaces a typed catalog.
export const fetchModelsBody = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('custom'), id: z.string().optional(), config: customConfigSchema }),
  z.object({ provider: z.literal('ollama'), id: z.string().optional(), config: ollamaConfigSchema }),
]);

// --- copilot device flow ---

export const copilotAuthPollBody = z.object({
  device_code: z.string().min(1),
  // Edit-form override routing every GitHub-side call through the
  // operator's in-progress chain. See proxy-resolution.ts.
  proxy_fallback_list: proxyFallbackListSchema.optional(),
});

// --- codex import / authorize-url / refresh ---
//
// The control plane refuses `provider: 'codex'` on the generic create / update
// upstream endpoints; Codex credentials enter only through these dedicated
// routes so the id_token parsing lives in one place.
//
// PKCE state is fully SPA-held: the dashboard mints `{verifier, challenge,
// state}` in the browser via Web Crypto, stores `{verifier, state}` in
// sessionStorage, and posts `challenge + state` here so the server can stamp
// them into the upstream's authorize URL. The server never sees the
// verifier until the callback comes back as `{code, verifier}` on import.

export const codexAuthorizeUrlBody = z.object({
  challenge: z.string().min(1),
  state: z.string().min(1),
});

// Path A — operator pastes `~/.codex/auth.json` verbatim. Path B — operator
// supplies the SPA-validated OAuth callback as `{code, verifier}`. The two
// paths are mutually exclusive; the refine below catches the both-or-neither
// case before the handler runs. State is not threaded through here:
// auth.openai.com rejects state on the token-exchange endpoint with 400
// unknown_parameter (live-probed); the SPA still validates state before
// sending the callback so CSRF protection is intact, but the gateway has
// no reason to receive it.
// Shared by claude-code OAuth + Setup-Token callbacks; codex defines its own callback inline because it omits `state`.
const oauthCallbackSchema = z.object({
  code: z.string().min(1),
  verifier: z.string().min(1),
  state: z.string().min(1),
});

const codexCredentialFields = {
  auth_json: z.string().min(1).optional(),
  callback: z.object({
    code: z.string().min(1),
    verifier: z.string().min(1),
  }).optional(),
  // Edit-form override carried through the import dialog. The PKCE token
  // exchange runs before the upstream record exists, so re-import uses the
  // persisted row's list as a fallback; on first-time import only the
  // override path is available.
  proxy_fallback_list: proxyFallbackListSchema.optional(),
};

// Both `codexImportBody.name` and `codexReimportBody.name` are optional. On
// import, the server synthesizes a default name from the id_token-derived
// identity (matching how copilot's device flow auto-names rows from the
// GitHub login); the operator can rename later from the edit page. On
// re-import, the existing row already has a name, so omitting it is the
// common case.
export const codexImportBody = z.object({
  name: z.string().min(1).optional(),
  sort_order: z.number().int().optional(),
  ...codexCredentialFields,
  // Pre-save proxy override: a brand-new upstream has no persisted chain, so
  // the OAuth bootstrap goes direct by default. When the operator has
  // already picked a fallback list in the in-flight form, send it here so
  // the bootstrap routes through that chain AND so the same chain is
  // persisted on the new row for subsequent data-plane calls.
  proxy_fallback_list: proxyFallbackListSchema.optional(),
}).refine(
  b => (b.auth_json !== undefined) !== (b.callback !== undefined),
  { message: 'Provide exactly one of auth_json or callback' },
);

// `sort_order` is omitted because re-import must not re-rank the row.
export const codexReimportBody = z.object({
  name: z.string().min(1).optional(),
  ...codexCredentialFields,
  // Edit-time override: same rationale as codexImportBody — the operator may
  // be changing the proxy chain in the same edit that re-imports the
  // credential. When present, route the bootstrap through the override and
  // overwrite the persisted list with it.
  proxy_fallback_list: proxyFallbackListSchema.optional(),
}).refine(
  b => (b.auth_json !== undefined) !== (b.callback !== undefined),
  { message: 'Provide exactly one of auth_json or callback' },
);

export const codexRefreshNowBody = z.object({
  // Edit-form override; absent falls back to the persisted row's list. See
  // proxy-resolution.ts.
  proxy_fallback_list: proxyFallbackListSchema.optional(),
});

// --- claude-code import / authorize-url / refresh ---
//
// Same shape rationale as the codex routes above: the generic create / update
// upstream endpoints reject `provider: 'claude-code'` and dedicated
// authorize-url + import + re-import endpoints own the OAuth handoff so
// credential parsing lives in one place. PKCE state is SPA-held (see codex
// section above for the architecture). The single authorize-url endpoint
// covers both the full-OAuth and Setup-Token scopes via the `kind`
// discriminator; the matching import endpoint per kind consumes the SPA-
// provided verifier. Every claude-code body below accepts the same in-flight
// `proxy_fallback_list` edit-form override with semantics documented in
// proxy-resolution.ts.

export const claudeCodeAuthorizeUrlBody = z.object({
  challenge: z.string().min(1),
  state: z.string().min(1),
  kind: z.enum(['oauth', 'setup-token']),
});

// Path A — operator pastes `~/.claude/.credentials.json` verbatim. Path B —
// operator supplies the SPA-validated OAuth callback as `{code, verifier,
// state}`. The two paths are mutually exclusive; the refine below catches
// the both-or-neither case before the handler runs.
const claudeCodeCredentialFields = {
  credentials_json: z.string().min(1).optional(),
  callback: oauthCallbackSchema.optional(),
};

export const claudeCodeImportBody = z.object({
  name: z.string().min(1).optional(),
  sort_order: z.number().int().optional(),
  ...claudeCodeCredentialFields,
  proxy_fallback_list: proxyFallbackListSchema.optional(),
}).refine(
  b => (b.credentials_json !== undefined) !== (b.callback !== undefined),
  { message: 'Provide exactly one of credentials_json or callback' },
);

export const claudeCodeReimportBody = z.object({
  name: z.string().min(1).optional(),
  ...claudeCodeCredentialFields,
  proxy_fallback_list: proxyFallbackListSchema.optional(),
}).refine(
  b => (b.credentials_json !== undefined) !== (b.callback !== undefined),
  { message: 'Provide exactly one of credentials_json or callback' },
);

export const claudeCodeRefreshNowBody = z.object({
  proxy_fallback_list: proxyFallbackListSchema.optional(),
});

// Same in-flight override slot as the refresh route: a probe fired from an
// unsaved edit form should reach Anthropic through the proxy chain the
// operator is currently editing, not the persisted one.
export const claudeCodeProbeQuotaBody = z.object({
  proxy_fallback_list: proxyFallbackListSchema.optional(),
});

// --- claude-code Setup-Token import / re-import ---
//
// The Setup-Token flow uses the same authorize host / client_id /
// redirect_uri / token endpoint as the regular OAuth flow but narrows the
// scope to `user:inference` (selected via the shared authorize-url
// endpoint's `kind: 'setup-token'`). The resulting credential has no
// refresh_token, so the import body has no credentials_json path
// (Anthropic's CLI never persists a setup token).

export const claudeCodeSetupTokenImportBody = z.object({
  name: z.string().min(1).optional(),
  sort_order: z.number().int().optional(),
  callback: oauthCallbackSchema,
  proxy_fallback_list: proxyFallbackListSchema.optional(),
});

export const claudeCodeSetupTokenReimportBody = z.object({
  name: z.string().min(1).optional(),
  callback: oauthCallbackSchema,
  proxy_fallback_list: proxyFallbackListSchema.optional(),
});

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
});

// --- data transfer ---

export const importBody = z.object({
  version: z.literal(6, { error: 'version must be 6 — older export formats are not supported; re-export from the current deployment' }),
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
export const searchUsageQuery = z.object({
  ...usageBaseQuery,
  provider: z.string().optional(),
});

export const performanceQuery = z.object({
  ...usageBaseQuery,
  metric_scope: z.enum(['request_total', 'upstream_success']).optional(),
  group_by: z.enum(['none', 'keyId', 'userId', 'model', 'runtimeLocation']).optional(),
  bucket: z.enum(['hour', '4h', '8h', 'day', 'all']).optional(),
  timezone_offset_minutes: z.string().optional(),
});
