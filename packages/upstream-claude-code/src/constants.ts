// All Claude Code OAuth + data-plane upstream constants. Pinned to the same
// public OAuth client the official `claude` CLI ships with. Cross-checked
// against the two top-popularity independent gateways shipping a Claude
// Code OAuth flow (different authors from each other and from Wei-Shaw):
//   https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/lib/claude_max.go
//   https://github.com/decolua/9router/blob/0c47c891e7a6c1a47c35b286235a132c0a5aa0a8/open-sse/providers/registry/claude.js
// Wei-Shaw maintains both `sub2api` and `claude-relay-service` — those
// repos count as ONE source for cross-reference purposes; cite them when
// useful but never as two independent confirmations.
export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

export const CLAUDE_CODE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const CLAUDE_CODE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

// Fixed redirect URI registered against CLAUDE_CODE_CLIENT_ID at Anthropic.
// Cannot be changed without re-registering the OAuth client.
export const CLAUDE_CODE_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';

// OAuth scope set: the three-scope CLI-heritage grant.
//   `org:create_api_key` — broadly available on every claude.ai OAuth flow;
//     keeping it means a future "mint an API key" affordance can land
//     without a re-consent loop.
//   `user:profile`       — required for `/api/oauth/profile` identity.
//   `user:inference`     — required for `/v1/messages` data-plane calls.
// This is what the official @anthropic-ai/claude-code CLI requests (cli.js
// 1.0.128, verified via grep) and what the two top-popularity independent
// gateways ship: plandex-ai/plandex (15k★, `claudeMaxScopes`) and
// decolua/9router (18k★, registry/claude.js `oauth.scopes`).
//   https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/lib/claude_max.go#L24
//   https://github.com/decolua/9router/blob/0c47c891e7a6c1a47c35b286235a132c0a5aa0a8/open-sse/providers/registry/claude.js#L74-L78
// Wei-Shaw's sub2api + claude-relay-service ship a broader six-scope set
// (adding `user:sessions:claude_code`, `user:mcp_servers`,
// `user:file_upload`); we deliberately do not, because we do not consume
// those scopes anywhere and a documented case (askalf/dario's repo) of
// Anthropic flipping the accepted shape across CC versions argues for the
// minimum-viable grant.
export const CLAUDE_CODE_OAUTH_SCOPE = 'org:create_api_key user:profile user:inference';

// Setup-Token scope: inference only. This is the credential class minted by
// Anthropic's "Create a Long-Lived Token" UI — safer for shared deployments
// because the token cannot mint API keys, hit `/api/oauth/profile`, or touch
// any account surface beyond inference. The trade-off: the token has no
// refresh_token and lasts ~1 year, so when it expires the operator must
// re-import. Single-sourced to Wei-Shaw (sub2api's `ScopeInference` and
// claude-relay-service's `SCOPES_SETUP` both ship this value); the
// `user:inference`-alone scope set is also the logical minimum for the
// inference-only credential class so the single-source risk is low.
//   https://github.com/Wei-Shaw/sub2api/blob/85a3b122545a6c914704f716a612aea00c3d7ecd/backend/internal/pkg/oauth/oauth.go#L31
//   https://github.com/Wei-Shaw/claude-relay-service/blob/13a8158922ff7654e79950fffe086ce5cfbc080c/src/utils/oauthHelper.js#L23
export const CLAUDE_CODE_OAUTH_SETUP_TOKEN_SCOPE = 'user:inference';

// 1 year in seconds. Sent in the setup-token `authorization_code` exchange
// body to request a long-lived access token; both sub2api and crs send the
// same literal. Regular OAuth exchanges omit this so the upstream picks the
// default (~1 hour) and we rely on the refresh_token for renewal.
export const CLAUDE_CODE_SETUP_TOKEN_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60;

// User-Agent on /v1/oauth/token. Real Claude Code's underlying HTTP layer is
// axios; pinning this matches the wire shape independent reimplementations
// observe in production.
export const CLAUDE_CODE_OAUTH_USER_AGENT = 'axios/1.13.6';

// Identity endpoint that derives email + account/organization UUIDs from a
// fresh access token. Hit on every credential ingestion path so config_json
// has a verified identity rather than trusting client-supplied values. Lives
// on api.anthropic.com (not platform.claude.com — the OAuth host) per
// every cross-checked third-party gateway.
export const CLAUDE_CODE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';

// Live quota probe Anthropic exposes for the OAuth bearer. Surfaces the
// same five-hour / seven-day window snapshot the official CLI fetches
// via its `fetchUtilization` helper.
export const CLAUDE_CODE_USAGE_PROBE_URL = 'https://api.anthropic.com/api/oauth/usage';
