// Renders the language-native assignment prefix that precedes the fixed,
// checked-in installer body in every setup-script response. Nothing here is
// interpolated: every external value (the long-lived API key and each opaque
// model / effort string) is emitted through a dedicated literal encoder, so a
// value carrying quotes, whitespace, or shell metacharacters cannot break out
// of its assignment. The prefix is the only place a setup-script response
// reveals the API key, and it does so as executable source rather than in the
// URL. The gateway never learns or renders its own public origin: the dashboard
// injects it into the executing shell (`FLOWAY_BASE_URL` / `$FlowayBaseUrl`),
// and the fixed installer body reads it from there.

import type { AgentSetupConfiguration } from './configuration.ts';

export interface RenderPrefixInput {
  // The selected long-lived Floway API key, in the clear.
  apiKey: string;
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

// Floway's placeholder ChatGPT identity is assembled by the installer body
// itself from `FLOWAY_BASE_URL` / `$FlowayBaseUrl`, so the gateway never needs
// the origin to render it. See the `codex_build_id_token` / `Get-FlowayCodexIdToken`
// helpers in scripts/{setup.sh,setup.ps1}.

// POSIX: `1` for a set flag, empty (which the installer reads as "remove this
// managed key") otherwise.
const shellFlag = (enabled: boolean): string => (enabled ? '1' : '');

// POSIX: an unset override renders as an empty value, matching the flag
// convention the installer uses to remove a managed key.
const shellOptional = (value: string | null): string => value ?? '';

const renderShellAssignments = (input: RenderPrefixInput): [name: string, value: string][] => {
  const { apiKey, configuration } = input;
  const { claudeCode, codex } = configuration;
  return [
    ['FLOWAY_API_KEY', apiKey],
    ['FLOWAY_INSTALL_CLAUDE', shellFlag(claudeCode.enabled)],
    ['FLOWAY_CLAUDE_MODEL', shellOptional(claudeCode.model)],
    ['FLOWAY_CLAUDE_DEFAULT_SONNET_MODEL', shellOptional(claudeCode.defaultSonnetModel)],
    ['FLOWAY_CLAUDE_DEFAULT_HAIKU_MODEL', shellOptional(claudeCode.defaultHaikuModel)],
    ['FLOWAY_CLAUDE_EFFORT_LEVEL', shellOptional(claudeCode.effortLevel)],
    ['FLOWAY_CLAUDE_MODEL_DISCOVERY', shellFlag(claudeCode.modelDiscovery)],
    ['FLOWAY_INSTALL_CODEX', shellFlag(codex.enabled)],
    ['FLOWAY_CODEX_MODEL', shellOptional(codex.model)],
    ['FLOWAY_CODEX_REASONING_EFFORT', shellOptional(codex.reasoningEffort)],
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
  const { apiKey, configuration } = input;
  const { claudeCode, codex } = configuration;
  return [
    ['$FlowayApiKey', powerShellLiteral(apiKey)],
    ['$FlowayInstallClaude', powerShellBool(claudeCode.enabled)],
    ['$FlowayClaudeModel', powerShellOptional(claudeCode.model)],
    ['$FlowayClaudeDefaultSonnetModel', powerShellOptional(claudeCode.defaultSonnetModel)],
    ['$FlowayClaudeDefaultHaikuModel', powerShellOptional(claudeCode.defaultHaikuModel)],
    ['$FlowayClaudeEffortLevel', powerShellOptional(claudeCode.effortLevel)],
    ['$FlowayClaudeModelDiscovery', powerShellBool(claudeCode.modelDiscovery)],
    ['$FlowayInstallCodex', powerShellBool(codex.enabled)],
    ['$FlowayCodexModel', powerShellOptional(codex.model)],
    ['$FlowayCodexReasoningEffort', powerShellOptional(codex.reasoningEffort)],
  ];
};

// `Set-PSDebug -Off` leads for the same reason `set +x` does in POSIX: it
// suppresses script tracing so the API key assignment is not echoed.
export const renderPowerShellPrefix = (input: RenderPrefixInput): string => {
  const lines = renderPowerShellAssignments(input).map(([name, value]) => `${name} = ${value}`);
  return `Set-PSDebug -Off\n${lines.join('\n')}\n`;
};
