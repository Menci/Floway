import type { FlagDefaults, FlagOverrides, ProviderModel } from '@floway-dev/provider';

// Exhaustive flag defaults for GitHub Copilot upstreams. Provider-wide
// defaults; per-Claude-model deltas live in `defaultFlagsForCopilotModel`
// below.
export const COPILOT_DEFAULT_FLAGS: FlagDefaults = {
  'vendor-deepseek': false,
  'vendor-qwen': false,
  'vendor-kimi': false,
  'messages-web-search-shim': true,
  'responses-web-search-shim': true,
  'responses-image-generation-shim': true,
  // Copilot has no native compact endpoint. The provider replays
  // `RemoteCompactionV2` through `/responses` with `stream: false` and a
  // trailing `compaction_trigger`, so this default leaves the gateway compact
  // shim off. The shim still engages on its own whenever a Responses request
  // lands on a Copilot Messages or Chat Completions target, neither of which
  // has a compaction wire.
  'responses-compact-shim': false,
  'disable-reasoning-on-forced-tool-choice': false,
  // Upstream default is off; Claude models below 4.8 flip it on via the
  // per-model default. See `defaultFlagsForCopilotModel` for the empirical
  // basis.
  'rewrite-mid-conv-system-to-user': false,
  'rewrite-developer-to-system': false,
  'rewrite-system-to-developer': false,
  'strip-billing-attribution': true,
  'strip-prompt-cache-key': false,
  'usage-exclusive-cached-tokens': false,
};

// True when the model id names a Claude release Copilot can serve an inline
// `role:'system'` turn for — a mid-conversation system message carried in
// `messages` rather than the top-level `system` field.
//
// Two independent things can reject such a turn, and this predicate has to
// cover both: the model may not implement the feature at all, or the
// deployment serving the request may run a validator that predates it.
//
// The id-family regex accepts any `claude-<family>-<major>[[.-]<minor>]`
// shape — the version number is the sole gate, family names are opaque
// (Anthropic ships new sub-families on their own schedule; the historical
// catalog is opus/sonnet/haiku but a future `claude-<newfamily>-<N.M>`
// routes the same way). Both dash-separated minor form (`claude-opus-4-8`,
// the shape copilotPublicModelId emits) and dotted form (`claude-opus-4.8`,
// seen on raw upstream ids) are accepted; whole-number releases drop the
// minor slot, missing minor is treated as 0.
//
// # Empirical evidence
//
// ## Direct functional test
//
// The validator constrains an inline system turn from both sides: it must
// FOLLOW a user turn and PRECEDE an assistant turn, so in a generation request
// the only legal position is last, immediately before the turn being
// generated. Probed in that position, with no `anthropic-beta` header (see
// below), against every Claude model in the catalog:
//
//     | model             | inline system turn |
//     | claude-opus-4.8   | accepted           |
//     | claude-opus-5     | accepted           |
//     | claude-sonnet-5   | accepted           |
//     | claude-opus-4.7   | rejected           |
//     | claude-haiku-4.5  | rejected           |
//     | claude-opus-4.6   | rejected           |
//     | claude-sonnet-4.6 | rejected           |
//
// Accept/reject is the model's own property and is what this predicate
// encodes. The wording of a rejection is not: it names the deployment that
// happened to serve that request. A deployment carrying the feature answers
// `role 'system' is not supported on this model`, reporting the model's
// limitation; one whose validator predates the feature answers `Unexpected
// role "system". The Messages API accepts a top-level system parameter...`,
// not recognising the role at all. Since the backend is chosen per request
// (see the routing section below), one model yields both strings over time —
// `claude-sonnet-4.6` usually draws the pre-feature wording and drew the
// feature-carrying one on the rounds it landed on Anthropic-direct. Nothing
// should key on the string.
//
// The `anthropic-beta: mid-conversation-system-2026-04-07` header does not
// help and can hurt: Vertex answers `Unexpected value for the 'anthropic-beta'
// header` when it appears, and elsewhere it is a no-op for models that have
// the feature. The Messages boundary normalization drops it, so the probe
// above measures what actually goes on the wire.
//
// ## Backend attribution
//
// Copilot serves this catalog from three Anthropic deployments, not two: AWS
// Bedrock, Google Vertex, and Anthropic's own API, chosen per request by
// Copilot's load balancer. The Anthropic message id names the one that served
// a response — `msg_vrtx_*`, `msg_bdrk_*`, or a bare `msg_01*` for
// Anthropic-direct. The infix is applied by the platform, not by a client
// library: both Anthropic SDKs contain zero occurrences of `bdrk` or `vrtx` in
// their sources, so a proxied response carries it exactly as a direct one
// does. Copilot strips Anthropic's `request-id` response header, which leaves
// the message id as the only backend signal on a success; a 400 carries no
// message id and is attributable only when its wording names a deployment.
//
// ## Routing distribution
//
// A two-day probe (Jun 26 → Jun 28 2026) hit the Copilot enterprise endpoint
// from two accounts every 30 minutes with an inline-system payload. It
// predates the message-id classifier and read the backend from validator
// wording, which separates deployments that carry the feature from those that
// do not rather than naming the platform — so its non-Vertex column merges
// Bedrock with Anthropic-direct. The Vertex column is the load-bearing one and
// is sound, `Unexpected role "system"` being the pre-feature validator.
//
//     | model              | non-Vertex | Vertex | non-Vertex% |
//     | claude-opus-4.8    |        163 |      0 |        100% |
//     | claude-opus-4.7    |         82 |     82 |         50% |
//     | claude-sonnet-4.6  |         46 |    117 |         28% |
//     | claude-opus-4.6    |         14 |    150 |          9% |
//     | claude-haiku-4.5   |         18 |    146 |         11% |
//     | claude-opus-4.5    |          0 |    164 |          0% |
//     | claude-sonnet-4.5  |          0 |    163 |          0% |
//
// A follow-up 80-sample probe (Jul 3 2026) covered the then-new
// `claude-sonnet-5`: 80/80 non-Vertex across both accounts. Backend selection
// is account-independent, and a later 4500-sample run (Jul 27 → Aug 1 2026)
// from two network egresses reproduced the same split with the message-id
// classifier and found the client's source address irrelevant to it. Vertex
// appeared only on models below 4.8 in every run.
//
// References:
// - https://github.com/anthropics/anthropic-sdk-typescript/tree/f298e9ad78cea4c047940a33d944f20e3f3b60f2/src (no `bdrk` / `vrtx` anywhere; the infix is the platform's)
// - https://github.com/anthropics/anthropic-sdk-python/tree/main/src/anthropic (same)
//
// Threshold conclusion: `>= 4.8`. This includes `claude-opus-4.8` and every
// 5.x release (which trivially exceeds `[4, 8]`); everything at 4.7 or below
// keeps the rewrite.
const supportsInlineSystem = (id: string): boolean => {
  const m = /^claude-[a-z]+-(\d+)(?:[.-](\d+))?$/.exec(id);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 8);
};

// Per-model default flag deltas for Copilot. Only Claude models below
// 4.8 opt into `rewrite-mid-conv-system-to-user`; every other flag
// inherits from `COPILOT_DEFAULT_FLAGS`. Upstream-wide operator overrides
// are applied before this provider-enforced per-model delta, so the technical
// requirement for affected Claude models remains authoritative.
export const defaultFlagsForCopilotModel = (model: Omit<ProviderModel, 'enabledFlags'>): FlagOverrides => {
  if (!model.id.startsWith('claude-')) return {};
  if (supportsInlineSystem(model.id)) return {};
  return { 'rewrite-mid-conv-system-to-user': true };
};
