// chatgpt_base_url sub-paths Codex calls during a ChatGPT-authenticated
// session. Each handler returns the matching client's successful empty shape
// so unsupported hosted services stay explicit without producing startup or
// normal-use 404 warnings.
//
// /plugins/featured, /plugins/list — legacy plugin marketplace. Clients in
//   codex-rs/core-plugins/src/remote_legacy.rs:120-198 deserialize a bare
//   JSON array (Vec<String> for featured ids; Vec<RemotePluginStatusSummary>
//   for the list). `[]` means "no plugins available" — disables the
//   marketplace UI without an error.
//
// /ps/plugins/list, /ps/plugins/installed — PS-backed marketplace
//   (codex-rs/core-plugins/src/remote.rs:1392-1448). Both deserialise into
//   `{ plugins: [...], pagination: { next_page_token: Option<String> } }`.
//
// /codex/analytics-events/events — codex only checks 2xx; the body is
//   discarded on success (codex-rs/analytics/src/client.rs:451-465). We
//   swallow events here to keep workspace telemetry inside Floway rather
//   than leaking to chatgpt.com if `chatgpt_base_url` were ever unset.
//
// /api/codex/usage, /api/codex/rate-limit-reset-credits, and its /consume
//   sub-route —
//   requires_openai_auth makes the TUI query account limits and reset credits.
//   Floway has neither a first-party ChatGPT quota nor redeemable credits, so
//   these report the client's supported `unknown` plan and zero credits:
//   https://github.com/openai/codex/blob/f90e7deea6a715bbd153044af6f475eefa749177/codex-rs/tui/src/chatwidget/rate_limits.rs#L295-L303
//   https://github.com/openai/codex/blob/f90e7deea6a715bbd153044af6f475eefa749177/codex-rs/backend-client/src/client/rate_limit_resets.rs#L30-L42
//   https://github.com/openai/codex/blob/f90e7deea6a715bbd153044af6f475eefa749177/codex-rs/backend-client/src/types.rs#L22-L55
//   https://github.com/openai/codex/blob/f90e7deea6a715bbd153044af6f475eefa749177/codex-rs/backend-client/src/types.rs#L74-L88
//
// /wham/agent-identities/jwks — only fetched by the enterprise
//   AgentIdentity login path; ChatGPT-mode never hits it. An empty JWKS
//   keeps the endpoint present for deployments that later wire it up.
//
// The /api/codex/apps MCP server lives in its own file (./apps-mcp.ts)
// because it carries real JSON-RPC plumbing.

import type { Context } from 'hono';

export const codexWhamAgentIdentitiesJwks = (c: Context) => c.json({ keys: [] });

export const codexAnalyticsEventsEvents = (c: Context) => c.body(null, 200);

export const codexUsage = (c: Context) => c.json({
  plan_type: 'unknown',
  rate_limit_reset_credits: { available_count: 0 },
});
export const codexRateLimitResetCredits = (c: Context) => c.json({ credits: [], available_count: 0 });
export const codexConsumeRateLimitResetCredit = (c: Context) => c.json({ code: 'no_credit', windows_reset: 0 });

export const codexPluginsFeatured = (c: Context) => c.json([]);
export const codexPluginsList = (c: Context) => c.json([]);

const emptyPluginsPage = { plugins: [], pagination: { next_page_token: null } };
export const codexPsPluginsList = (c: Context) => c.json(emptyPluginsPage);
export const codexPsPluginsInstalled = (c: Context) => c.json(emptyPluginsPage);
