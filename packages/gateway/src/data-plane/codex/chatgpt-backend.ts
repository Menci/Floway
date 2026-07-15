// chatgpt_base_url sub-paths codex pokes during a session. Each handler
// returns the minimum shape the matching client deserialiser accepts as a
// successful empty result, so the user does not see "404 Not Found" warn
// noise during startup or normal use.
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
// /wham/agent-identities/jwks — only fetched by the enterprise
//   AgentIdentity login path; ChatGPT-mode never hits it. An empty JWKS
//   keeps the endpoint present for deployments that later wire it up.
//
// The /api/codex/apps MCP server lives in its own file (./apps-mcp.ts)
// because it carries real JSON-RPC plumbing.

import type { Context } from 'hono';

export const codexWhamAgentIdentitiesJwks = (c: Context) => c.json({ keys: [] });

export const codexAnalyticsEventsEvents = (c: Context) => c.body(null, 200);

export const codexPluginsFeatured = (c: Context) => c.json([]);
export const codexPluginsList = (c: Context) => c.json([]);

const emptyPluginsPage = { plugins: [], pagination: { next_page_token: null } };
export const codexPsPluginsList = (c: Context) => c.json(emptyPluginsPage);
export const codexPsPluginsInstalled = (c: Context) => c.json(emptyPluginsPage);
