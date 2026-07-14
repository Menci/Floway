import type { FlagDefaults, FlagOverrides, ProviderModel } from '@floway-dev/provider';

// Exhaustive flag defaults for GitHub Copilot upstreams. Provider-wide
// defaults; per-Claude-model deltas live in `defaultFlagsForCopilotModel`
// below.
export const COPILOT_DEFAULT_FLAGS: FlagDefaults = {
  'vendor-deepseek': false,
  'vendor-qwen': false,
  'vendor-kimi': false,
  // Copilot occasionally serves a cyber_policy 4xx from the upstream that
  // clears on retry; the flag defaults on for Copilot to swallow the
  // transient class without operator intervention.
  'retry-cyber-policy': true,
  'messages-web-search-shim': true,
  'responses-web-search-shim': true,
  'responses-image-generation-shim': true,
  // Copilot exposes a native /responses/compact wire.
  'responses-compact-shim': false,
  'disable-reasoning-on-forced-tool-choice': false,
  // Upstream default is off; Claude models below 4.8 flip it on via the
  // per-model default. See `defaultFlagsForCopilotModel` for the empirical
  // basis.
  'demote-interleaved-system-to-user': false,
  'demote-developer-to-system': false,
  'promote-system-to-developer': false,
  'strip-billing-attribution': true,
  'strip-prompt-cache-key': false,
};

// True when the model id names a Claude release whose Anthropic Messages
// wire accepts inline `role:'system'` (i.e., a mid-conversation system
// turn placed between assistant/user turns rather than in the top-level
// `system` field).
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
// Copilot's Claude model catalog is served through both AWS Bedrock and
// Google Vertex, with the choice made per-request by Copilot's own load
// balancer. Only Bedrock has shipped Anthropic's mid-conversation-system
// feature; Vertex still validates against the pre-feature role enum
// `user | assistant` and rejects `role:'system'` outright with:
//
//     Unexpected role "system". The Messages API accepts a top-level
//     `system` parameter, not "system" as an input message role.
//
// The `anthropic-beta: mid-conversation-system-2026-04-07` header does
// NOT unlock this on Vertex — Vertex returns
// `Unexpected value for the 'anthropic-beta' header` when it appears.
// On Bedrock the header is a no-op (the feature is GA there for models
// that have it).
//
// So the operative question is: given a public model id, does the
// Copilot LB route to Bedrock deterministically enough that we can
// leave inline system on, or is the model split across backends where
// we must demote to avoid random Vertex-side 400s?
//
// We ran a two-day cron-driven probe (Jun 26 → Jun 28 2026) that hit
// the Copilot enterprise endpoint from two accounts (personal + GHE)
// every 30
// minutes with a Shape E payload
// (`[user, assistant, system, user]` + the beta header) against every
// Claude model then in the catalog. The classifier keyed on
// `request_id`: `req_vrtx_*` = Vertex; bare `req_*` = Bedrock
// (Copilot forwards AWS `InvokeModel` calls whose ids never carry the
// `bdrk_` infix Anthropic's own SDK wrapper adds). Where Copilot
// stripped the id, backend was recovered from validator wording —
// `Unexpected role "system"` = Vertex legacy, `messages.N: role
// 'system' must ...` = Bedrock mid-conv validator.
//
// After 40h / 1150 samples the distribution was:
//
//     | model              | Bedrock | Vertex | Bedrock% |
//     | claude-opus-4.8    |     163 |      0 |     100% |
//     | claude-opus-4.7    |      82 |     82 |      50% |
//     | claude-sonnet-4.6  |      46 |    117 |      28% |
//     | claude-opus-4.6    |      14 |    150 |       9% |
//     | claude-haiku-4.5   |      18 |    146 |      11% |
//     | claude-opus-4.5    |       0 |    164 |       0% |
//     | claude-sonnet-4.5  |       0 |    163 |       0% |
//
// A follow-up 80-sample probe (Jul 3 2026) covered the newly-released
// `claude-sonnet-5`; 80/80 = 100% Bedrock across both accounts. The
// version-threshold hypothesis — Anthropic released mid-conv system on
// Bedrock alongside the 4.8 line and every subsequent release ships
// Bedrock-only routing — held; the equivalent check for older models
// showed no Bedrock-favoring drift versus the earlier probe. The
// backend selection is also account-independent (both accounts agreed
// within ±5% on every non-4.8 model, and 100% on 4.8 / sonnet-5).
//
// Threshold conclusion: `>= 4.8`. This includes `claude-opus-4.8` and
// every 5.x release (which trivially exceeds `[4, 8]`); everything at
// 4.7 or below stays demoted.
const supportsInlineSystem = (id: string): boolean => {
  const m = /^claude-[a-z]+-(\d+)(?:[.-](\d+))?$/.exec(id);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 8);
};

// Per-model default flag deltas for Copilot. Only Claude models below
// 4.8 opt into `demote-interleaved-system-to-user`; every other flag
// inherits from `COPILOT_DEFAULT_FLAGS`. Upstream-wide operator overrides
// are applied before this provider-enforced per-model delta, so the technical
// requirement for affected Claude models remains authoritative.
export const defaultFlagsForCopilotModel = (model: Omit<ProviderModel, 'enabledFlags'>): FlagOverrides => {
  if (!model.id.startsWith('claude-')) return {};
  if (supportsInlineSystem(model.id)) return {};
  return { 'demote-interleaved-system-to-user': true };
};
