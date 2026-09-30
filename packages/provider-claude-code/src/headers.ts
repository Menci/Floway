// Pinned mimicry header surface for the Anthropic /v1/messages?beta=true call
// on a Claude Code subscription OAuth bearer. Claude Code v2.1.280's CLI and
// embedded SDK versions are verified from its
// official Linux x64 package. The curated beta surface below remains grounded
// in the last captured live request; bump each value only with evidence for
// that surface.
//
// Anthropic's "third-party" detector keys on the full surface (UA, X-App,
// X-Stainless-*, anthropic-beta, anthropic-version,
// anthropic-dangerous-direct-browser-access) plus the body shape; missing any
// one is sufficient to downgrade a Sonnet/Opus call to extra-usage billing.
// 2026-06-19 probes showed the detector effectively paused, but Anthropic
// can re-arm it at any time, so we ship the full surface defensively.
//
// Casing on the wire matches what is written below: lowercase `anthropic-*`,
// `x-app`, `authorization`; mixed-case `User-Agent`, `Accept`, `Content-Type`,
// and the `X-Stainless-*` family. Both Cloudflare Workers and
// @hono/node-server preserve the casing we set on a `Headers` instance.

export const CLAUDE_CLI_VERSION = '2.1.280';

// `@anthropic-ai/sdk` version bundled inside Claude Code v2.1.280; surfaces
// on the wire as `X-Stainless-Package-Version`.
// https://registry.npmjs.org/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.280.tgz
const STAINLESS_PACKAGE_VERSION = '0.112.1';

// Stable subset of `X-Stainless-*` headers shared across both model groups.
// `X-Stainless-OS` keeps its uppercase 'Linux' value verbatim — the real CLI
// emits it that way. OS / Arch / Runtime values verified against the macOS
// arm64 CC binary 2026-06-19; cross-platform CC builds (Windows / x86_64)
// would emit different values, so re-capture on any platform bump.
//
// `X-Stainless-Helper-Method: stream` is always set: every /v1/messages
// call we make to Anthropic is a streaming call (see `wireBody.stream =
// true` in fetch.ts), so this matches real CC's wire output captured in
// `@anthropic-ai/claude-code@2.1.10` cli.js and sub2api's pinned set
// (gateway_service.go:7427-7429 / allowedHeaders list at :432).
const STAINLESS_BASE = {
  'X-Stainless-Lang': 'js',
  'X-Stainless-Package-Version': STAINLESS_PACKAGE_VERSION,
  'X-Stainless-OS': 'Linux',
  'X-Stainless-Arch': 'arm64',
  'X-Stainless-Runtime': 'node',
  'X-Stainless-Runtime-Version': 'v24.3.0',
  'X-Stainless-Retry-Count': '0',
  'X-Stainless-Timeout': '600',
  'X-Stainless-Helper-Method': 'stream',
} as const;

const BASE_HEADERS = {
  'User-Agent': `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`,
  'x-app': 'cli',
  'anthropic-dangerous-direct-browser-access': 'true',
  'anthropic-version': '2023-06-01',
  Accept: 'application/json',
  'Content-Type': 'application/json',
  ...STAINLESS_BASE,
} as const;

// `anthropic-beta` flag set carried by Sonnet/Opus Claude Code requests at
// v2.1.181, byte-for-byte aligned with a fresh capture of the live CLI on
// 2026-06-19. Sub2api's curated set
// (`backend/internal/service/constants.go` `FullClaudeCodeMimicryBetas`)
// snapshotted v2.1.161 and predates `mid-conversation-system-2026-04-07`;
// we ship the post-2.1.161 release window verbatim instead. Order matters:
// leading with `claude-code-20250219` matches the wire fixtures.
//
// `mid-conversation-system-2026-04-07` is a capability flag — it tells
// the upstream the client can place `{role: "system", content: ...}`
// blocks anywhere in the conversation. It does nothing on its own;
// only a payload that actually uses a mid-conversation system block
// could trip a 400 on a model that doesn't support it, so blanket-
// sending it to every Sonnet/Opus call is safe and matches the CLI.
//
// Two tokens from v2.1.181's beta set are intentionally NOT shipped:
//   * `redact-thinking-2026-02-12` — instructs the upstream to strip
//     thinking content from the response, which fights the gateway's
//     pass-through goal. Sub2api omits with the same rationale at
//     `claude/constants.go:78`.
//   * `summarize-connector-text-2026-03-13` — only fires under MCP
//     connector use, which our gateway does not manage. Sending it
//     without a connector wired up just adds detector keying surface.
const ANTHROPIC_BETA_SONNET_OPUS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'prompt-caching-scope-2026-01-05',
  'effort-2025-11-24',
  'context-management-2025-06-27',
  'extended-cache-ttl-2025-04-11',
  'mid-conversation-system-2026-04-07',
].join(',');

// Haiku ships a leaner beta set — Anthropic's detector for Haiku is looser
// but we still send the full Haiku surface for consistency and forward
// robustness against detector tightening.
const ANTHROPIC_BETA_HAIKU = [
  'oauth-2025-04-20',
  'claude-code-20250219',
  'fine-grained-tool-streaming-2025-05-14',
].join(',');

export const CLAUDE_CODE_HEADERS_SONNET_OPUS: Record<string, string> = {
  ...BASE_HEADERS,
  'anthropic-beta': ANTHROPIC_BETA_SONNET_OPUS,
};

export const CLAUDE_CODE_HEADERS_HAIKU: Record<string, string> = {
  ...BASE_HEADERS,
  'anthropic-beta': ANTHROPIC_BETA_HAIKU,
};

export const pickClaudeCodeHeaders = (modelId: string): Record<string, string> =>
  modelId.includes('haiku') ? CLAUDE_CODE_HEADERS_HAIKU : CLAUDE_CODE_HEADERS_SONNET_OPUS;
