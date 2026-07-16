// Renders the language-native assignment prefix prepended to the fixed,
// checked-in installer body in every setup-script response. Every external
// value (the API key and each opaque model/effort string) is emitted through a
// single-quoted literal encoder, so quotes, whitespace, or shell metacharacters
// can never break out of an assignment — the real injection defense. The
// gateway never renders its own public origin: the dashboard injects it into
// the executing shell, and the fixed installer body reads it from there.

import type { AgentSetupConfiguration } from './configuration.ts';

export interface RenderPrefixInput {
  apiKey: string;
  configuration: AgentSetupConfiguration;
}

const assertNoNul = (value: string): void => {
  if (value.includes('\0')) throw new Error('cannot render a value containing a NUL character');
};

// POSIX single-quoted literal: the single quote is closed, escaped as `\'`, and
// reopened; every other character (newlines, tabs, Unicode) is literal. NUL
// cannot exist in a shell word and is rejected.
const shellLiteral = (value: string): string => {
  assertNoNul(value);
  return `'${value.replace(/'/g, "'\\''")}'`;
};

// PowerShell single-quoted literal: single quotes are the only escape, doubled.
const powerShellLiteral = (value: string): string => {
  assertNoNul(value);
  return `'${value.replace(/'/g, "''")}'`;
};

// An unset override renders empty, which the installer reads as "remove this
// managed key"; a set flag renders `1`.
const shellFlag = (enabled: boolean): string => (enabled ? '1' : '');
const shellOptional = (value: string | null): string => value ?? '';

// `set +x` leads so a caller who piped us into `set -x` cannot echo the API-key
// assignment to its trace stream; the trailing newline lets the fixed installer
// body concatenate cleanly beneath.
export const renderShellPrefix = (input: RenderPrefixInput): string => {
  const { apiKey, configuration: { claudeCode, codex } } = input;
  const assignments: [name: string, value: string][] = [
    ['FLOWAY_API_KEY', apiKey],
    ['FLOWAY_INSTALL_CLAUDE', shellFlag(claudeCode.enabled)],
    ['FLOWAY_CLAUDE_MODEL', shellOptional(claudeCode.model)],
    ['FLOWAY_CLAUDE_DEFAULT_OPUS_MODEL', shellOptional(claudeCode.defaultOpusModel)],
    ['FLOWAY_CLAUDE_DEFAULT_SONNET_MODEL', shellOptional(claudeCode.defaultSonnetModel)],
    ['FLOWAY_CLAUDE_DEFAULT_HAIKU_MODEL', shellOptional(claudeCode.defaultHaikuModel)],
    ['FLOWAY_CLAUDE_EFFORT_LEVEL', shellOptional(claudeCode.effortLevel)],
    ['FLOWAY_CLAUDE_MODEL_DISCOVERY', shellFlag(claudeCode.modelDiscovery)],
    ['FLOWAY_INSTALL_CODEX', shellFlag(codex.enabled)],
    ['FLOWAY_CODEX_MODEL', shellOptional(codex.model)],
    ['FLOWAY_CODEX_REASONING_EFFORT', shellOptional(codex.reasoningEffort)],
  ];
  const lines = assignments.map(([name, value]) => `${name}=${shellLiteral(value)}`);
  return `set +x\n${lines.join('\n')}\n`;
};

// PowerShell: booleans and $null render bare; only strings are quoted, so the
// encoder cannot be applied uniformly the way the POSIX renderer applies it.
const powerShellBool = (value: boolean): string => (value ? '$true' : '$false');
const powerShellOptional = (value: string | null): string => (value === null ? '$null' : powerShellLiteral(value));

// `Set-PSDebug -Off` leads for the same reason `set +x` does in POSIX.
export const renderPowerShellPrefix = (input: RenderPrefixInput): string => {
  const { apiKey, configuration: { claudeCode, codex } } = input;
  const assignments: [name: string, value: string][] = [
    ['$FlowayApiKey', powerShellLiteral(apiKey)],
    ['$FlowayInstallClaude', powerShellBool(claudeCode.enabled)],
    ['$FlowayClaudeModel', powerShellOptional(claudeCode.model)],
    ['$FlowayClaudeDefaultOpusModel', powerShellOptional(claudeCode.defaultOpusModel)],
    ['$FlowayClaudeDefaultSonnetModel', powerShellOptional(claudeCode.defaultSonnetModel)],
    ['$FlowayClaudeDefaultHaikuModel', powerShellOptional(claudeCode.defaultHaikuModel)],
    ['$FlowayClaudeEffortLevel', powerShellOptional(claudeCode.effortLevel)],
    ['$FlowayClaudeModelDiscovery', powerShellBool(claudeCode.modelDiscovery)],
    ['$FlowayInstallCodex', powerShellBool(codex.enabled)],
    ['$FlowayCodexModel', powerShellOptional(codex.model)],
    ['$FlowayCodexReasoningEffort', powerShellOptional(codex.reasoningEffort)],
  ];
  const lines = assignments.map(([name, value]) => `${name} = ${value}`);
  return `Set-PSDebug -Off\n${lines.join('\n')}\n`;
};
