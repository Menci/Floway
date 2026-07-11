// Renders the language-native assignment prefix that precedes the fixed,
// checked-in installer body in every setup-script response. Nothing here is
// interpolated: every external value (the long-lived API key, the origin, and
// each opaque model / effort string) is emitted through a dedicated literal
// encoder, so a value carrying quotes, whitespace, or shell metacharacters
// cannot break out of its assignment. The prefix is the only place a
// setup-script response reveals the API key, and it does so as executable
// source rather than in the URL.

import type { AgentSetupConfiguration } from './configuration.ts';
import { encodeBase64UrlJson } from '../../shared/base64url-json.ts';

export interface RenderPrefixInput {
  // The selected long-lived Floway API key, in the clear.
  apiKey: string;
  // The externally visible Floway origin (scheme + host), resolved from the
  // request at serve time; also the host source for the Codex identity token.
  baseUrl: string;
  configuration: AgentSetupConfiguration;
}

const assertNoNul = (value: string): void => {
  if (value.includes('\0')) throw new Error('cannot render a value containing a NUL character');
};

// POSIX single-quoted literal: everything inside single quotes is literal
// except the single quote itself, which is closed, escaped as `\'`, and
// reopened. Newlines, tabs, and Unicode survive verbatim; NUL cannot be
// represented in a shell word and is rejected.
export const shellLiteral = (value: string): string => {
  assertNoNul(value);
  return `'${value.replace(/'/g, "'\\''")}'`;
};

// PowerShell single-quoted literal: single quotes are the only escape and are
// doubled; every other character (including newlines and Unicode) is literal.
// NUL is rejected for the same reason as the POSIX encoder.
export const powerShellLiteral = (value: string): string => {
  assertNoNul(value);
  return `'${value.replace(/'/g, "''")}'`;
};

// Floway's placeholder ChatGPT identity, mirrored into the Codex-mode
// `auth.json` the installer writes. The Codex CLI decodes this token to render
// `codex login status`; it is never verified (`alg: none`) because the gateway
// authenticates the data plane with the API key carried as `access_token`, not
// with this token. The host-derived email keeps multiple deployments
// distinguishable in the CLI's status output.
// Ref: packages/provider-codex/src/auth/jwt.ts (the decode-only claim reader).
const FLOWAY_CODEX_AUTH_CLAIM = {
  chatgpt_plan_type: 'pro_plus',
  chatgpt_user_id: 'user-floway',
  chatgpt_account_id: 'acct-floway',
} as const;

// Static, non-verified signature segment (`base64url("sig")`); `alg: none`
// means Codex ignores it.
const CODEX_IDENTITY_TOKEN_SIGNATURE = 'c2ln';

// Assemble the parseable Codex identity token from the origin host. Kept on the
// server so the installer performs no JWT/base64url assembly. Deterministic:
// object key order fixes the encoded bytes for a given host.
export const renderCodexIdentityToken = (baseUrl: string): string => {
  const host = new URL(baseUrl).host;
  const header = encodeBase64UrlJson({ alg: 'none', typ: 'JWT' });
  const payload = encodeBase64UrlJson({
    email: `floway@${host}`,
    'https://api.openai.com/auth': FLOWAY_CODEX_AUTH_CLAIM,
  });
  return `${header}.${payload}.${CODEX_IDENTITY_TOKEN_SIGNATURE}`;
};

// POSIX: `1` for a set flag, empty (which the installer reads as "remove this
// managed key") otherwise.
const shellFlag = (enabled: boolean): string => (enabled ? '1' : '');

// POSIX: an unset override renders as an empty value, matching the flag
// convention the installer uses to remove a managed key.
const shellOptional = (value: string | null): string => value ?? '';

const renderShellAssignments = (input: RenderPrefixInput): [name: string, value: string][] => {
  const { apiKey, baseUrl, configuration } = input;
  const { claudeCode, codex } = configuration;
  return [
    ['FLOWAY_API_KEY', apiKey],
    ['FLOWAY_BASE_URL', baseUrl],
    ['FLOWAY_INSTALL_CLAUDE', shellFlag(claudeCode.enabled)],
    ['FLOWAY_CLAUDE_MODEL', shellOptional(claudeCode.model)],
    ['FLOWAY_CLAUDE_DEFAULT_SONNET_MODEL', shellOptional(claudeCode.defaultSonnetModel)],
    ['FLOWAY_CLAUDE_DEFAULT_HAIKU_MODEL', shellOptional(claudeCode.defaultHaikuModel)],
    ['FLOWAY_CLAUDE_EFFORT_LEVEL', shellOptional(claudeCode.effortLevel)],
    ['FLOWAY_CLAUDE_MODEL_DISCOVERY', shellFlag(claudeCode.modelDiscovery)],
    ['FLOWAY_INSTALL_CODEX', shellFlag(codex.enabled)],
    ['FLOWAY_CODEX_MODEL', shellOptional(codex.model)],
    ['FLOWAY_CODEX_REASONING_EFFORT', shellOptional(codex.reasoningEffort)],
    ['FLOWAY_CODEX_ID_TOKEN', renderCodexIdentityToken(baseUrl)],
  ];
};

// `set +x` leads so a caller who piped us into `set -x` cannot echo the API
// key assignment to its trace stream. The prefix ends with a trailing newline
// so the fixed installer body concatenates cleanly beneath it.
export const renderShellPrefix = (input: RenderPrefixInput): string => {
  const lines = renderShellAssignments(input).map(([name, value]) => `${name}=${shellLiteral(value)}`);
  return `set +x\n${lines.join('\n')}\n`;
};

// PowerShell: `$true` / `$false` for a set flag.
const powerShellBool = (value: boolean): string => (value ? '$true' : '$false');

// PowerShell: an unset override renders as `$null`, which the installer reads
// as "remove this managed key".
const powerShellOptional = (value: string | null): string => (value === null ? '$null' : powerShellLiteral(value));

const renderPowerShellAssignments = (input: RenderPrefixInput): [name: string, value: string][] => {
  const { apiKey, baseUrl, configuration } = input;
  const { claudeCode, codex } = configuration;
  return [
    ['$FlowayApiKey', powerShellLiteral(apiKey)],
    ['$FlowayBaseUrl', powerShellLiteral(baseUrl)],
    ['$FlowayInstallClaude', powerShellBool(claudeCode.enabled)],
    ['$FlowayClaudeModel', powerShellOptional(claudeCode.model)],
    ['$FlowayClaudeDefaultSonnetModel', powerShellOptional(claudeCode.defaultSonnetModel)],
    ['$FlowayClaudeDefaultHaikuModel', powerShellOptional(claudeCode.defaultHaikuModel)],
    ['$FlowayClaudeEffortLevel', powerShellOptional(claudeCode.effortLevel)],
    ['$FlowayClaudeModelDiscovery', powerShellBool(claudeCode.modelDiscovery)],
    ['$FlowayInstallCodex', powerShellBool(codex.enabled)],
    ['$FlowayCodexModel', powerShellOptional(codex.model)],
    ['$FlowayCodexReasoningEffort', powerShellOptional(codex.reasoningEffort)],
    ['$FlowayCodexIdToken', powerShellLiteral(renderCodexIdentityToken(baseUrl))],
  ];
};

// `Set-PSDebug -Off` leads for the same reason `set +x` does in POSIX: it
// suppresses script tracing so the API key assignment is not echoed.
export const renderPowerShellPrefix = (input: RenderPrefixInput): string => {
  const lines = renderPowerShellAssignments(input).map(([name, value]) => `${name} = ${value}`);
  return `Set-PSDebug -Off\n${lines.join('\n')}\n`;
};
