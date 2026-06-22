// All Codex / ChatGPT upstream constants. Do NOT make these operator-
// configurable — wrapper-identifying UA suffixes trigger selective 401s from
// OpenAI's bot management.

// codex-cli's OAuth client id. Used at auth.openai.com for both authorize and
// token-exchange. Same value across the canonical Codex CLI source and every
// independent reimplementation surveyed on GitHub:
// https://github.com/openai/codex/blob/87b808bb570f01f4b6fc8485c5459052fac0e320/codex-rs/login/src/auth/manager.rs
// https://github.com/170-carry/codex-tools/blob/0b0910b2b5351372e9ece1a82b3d5ea2ce7c3da5/src-tauri/src/auth.rs
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';

// Fixed redirect URI registered against CODEX_CLIENT_ID at OpenAI.
// Cannot be changed without re-registering the OAuth client.
export const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';

// OAuth scope minimum-confirmed across implementations. We do NOT request the
// connector scopes (api.connectors.read / .invoke) — they are only needed for
// the MCP-connector feature and unrelated to /codex/responses.
export const CODEX_OAUTH_SCOPE = 'openid profile email offline_access';

// OAuth User-Agent. Pinned independently of the data-plane CODEX_CLI_VERSION:
// `0.91.0` is the version captured by OpenAI when the codex-cli OAuth client
// was first registered, and the auth.openai.com /token + /authorize endpoints
// continue to accept it across CLI revisions (cross-checked against
// sub2api/backend, which is in continuous production use against the same
// endpoints with this exact UA). Note the hyphen-lowercase product name —
// distinct from the underscore form used on the data plane below.
export const CODEX_OAUTH_USER_AGENT = 'codex-cli/0.91.0';

export const CODEX_BACKEND_BASE = 'https://chatgpt.com/backend-api';
export const CODEX_RESPONSES_PATH = '/codex/responses';
export const CODEX_MODELS_PATH = '/codex/models';

// codex_cli_rs version we impersonate on the data plane. Bumped against the
// latest tag at https://github.com/openai/codex/releases — newer entries in
// /codex/models gate themselves behind a `minimal_client_version` (e.g.
// gpt-5.5 needs 0.124.0+), so a stale value here silently truncates the model
// list. The same value flows into both the `?client_version=` query param and
// the User-Agent so the upstream sees a self-consistent client.
export const CODEX_CLI_VERSION = '0.137.0';

// Identity headers for /codex/responses. Bare User-Agent — no
// parenthetical OS/arch/terminal suffix per the bot-management
// constraint at the top of this file.
export const CODEX_ORIGINATOR = 'codex_cli_rs';
export const CODEX_USER_AGENT = `codex_cli_rs/${CODEX_CLI_VERSION}`;

// CLIProxyAPI's current Codex Responses executor presents as codex-tui
// rather than codex_cli_rs. Keep this scoped to /codex/responses: model
// listing still depends on the codex_cli_rs client_version contract above.
export const CODEX_RESPONSES_ORIGINATOR = 'codex-tui';
export const CODEX_RESPONSES_USER_AGENT = 'codex-tui/0.135.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.135.0)';
