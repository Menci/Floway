// Renders the language-native assignment prefix prepended to the fixed,
// checked-in installer body in every setup-script response. Every external
// value (the API key and each opaque model/effort string) is emitted through a
// single-quoted literal encoder, so quotes, whitespace, or shell metacharacters
// can never break out of an assignment — the real injection defense. The
// gateway never renders its own public origin: the dashboard injects it into
// the executing shell, and the fixed installer body reads it from there.

import type { AgentSetupConfiguration } from './configuration.ts';

export interface RenderPrefixInput {
  agent: 'claude' | 'codex';
  apiKey: string;
  apiKeyName: string;
  configuration: AgentSetupConfiguration;
}

const assertNoNul = (value: string): void => {
  if (value.includes('\0')) throw new Error('cannot render a value containing a NUL character');
};

// Flatten every C0/DEL control byte to a space so a key label cannot smuggle a
// terminal escape into the metadata assignment. The value still flows through a
// literal encoder afterward, which is where a NUL is rejected.
const metadataValue = (value: string): string => value.replace(/[\u0001-\u001f\u007f]/g, ' ');

// --- POSIX shell ---

// POSIX single-quoted literal: the single quote is closed, escaped as `\'`, and
// reopened; every other character (newlines, tabs, Unicode) is literal. NUL
// cannot exist in a shell word and is rejected.
const shellLiteral = (value: string): string => {
  assertNoNul(value);
  return `'${value.replace(/'/g, "'\\''")}'`;
};

// An unset override renders empty, which the installer reads as "remove this
// managed key".
const shellFlag = (enabled: boolean): string => (enabled ? '1' : '');
const shellOptional = (value: string | null): string => value ?? '';

// `set +x` leads so a caller who piped us into `set -x` cannot echo the API-key
// assignment to its trace stream; the trailing newline lets the fixed installer
// body concatenate cleanly beneath.
export const renderShellPrefix = (input: RenderPrefixInput): string => {
  const { agent, apiKey, apiKeyName, configuration } = input;
  const assignments: [name: string, value: string][] = [
    ['SETUP_API_KEY', apiKey],
    ['SETUP_API_KEY_NAME', metadataValue(apiKeyName)],
  ];
  if (agent === 'claude') {
    const { claudeCode } = configuration;
    assignments.push(
      ['SETUP_CLAUDE_MODEL', shellOptional(claudeCode.model)],
      ['SETUP_CLAUDE_DEFAULT_OPUS_MODEL', shellOptional(claudeCode.defaultOpusModel)],
      ['SETUP_CLAUDE_DEFAULT_SONNET_MODEL', shellOptional(claudeCode.defaultSonnetModel)],
      ['SETUP_CLAUDE_DEFAULT_HAIKU_MODEL', shellOptional(claudeCode.defaultHaikuModel)],
      ['SETUP_CLAUDE_EFFORT_LEVEL', shellOptional(claudeCode.effortLevel)],
      ['SETUP_CLAUDE_MODEL_DISCOVERY', shellFlag(claudeCode.modelDiscovery)],
    );
  } else {
    assignments.push(
      ['SETUP_CODEX_MODEL', shellOptional(configuration.codex.model)],
      ['SETUP_CODEX_REASONING_EFFORT', shellOptional(configuration.codex.reasoningEffort)],
    );
  }
  const lines = assignments.map(([name, value]) => `${name}=${shellLiteral(value)}`);
  return `set +x\n${lines.join('\n')}\n`;
};

// --- PowerShell ---

// PowerShell single-quoted literal: single quotes are the only escape, doubled.
const powerShellLiteral = (value: string): string => {
  assertNoNul(value);
  return `'${value.replace(/'/g, "''")}'`;
};

// PowerShell: booleans and $null render bare; only strings are quoted, so the
// encoder cannot be applied uniformly the way the POSIX renderer applies it.
const powerShellBool = (value: boolean): string => (value ? '$true' : '$false');
const powerShellOptional = (value: string | null): string => (value === null ? '$null' : powerShellLiteral(value));

// `Set-PSDebug -Off` leads for the same reason `set +x` does in POSIX.
export const renderPowerShellPrefix = (input: RenderPrefixInput): string => {
  const { agent, apiKey, apiKeyName, configuration } = input;
  const assignments: [name: string, value: string][] = [
    ['$SetupApiKey', powerShellLiteral(apiKey)],
    ['$SetupApiKeyName', powerShellLiteral(metadataValue(apiKeyName))],
  ];
  if (agent === 'claude') {
    const { claudeCode } = configuration;
    assignments.push(
      ['$SetupClaudeModel', powerShellOptional(claudeCode.model)],
      ['$SetupClaudeDefaultOpusModel', powerShellOptional(claudeCode.defaultOpusModel)],
      ['$SetupClaudeDefaultSonnetModel', powerShellOptional(claudeCode.defaultSonnetModel)],
      ['$SetupClaudeDefaultHaikuModel', powerShellOptional(claudeCode.defaultHaikuModel)],
      ['$SetupClaudeEffortLevel', powerShellOptional(claudeCode.effortLevel)],
      ['$SetupClaudeModelDiscovery', powerShellBool(claudeCode.modelDiscovery)],
    );
  } else {
    assignments.push(
      ['$SetupCodexModel', powerShellOptional(configuration.codex.model)],
      ['$SetupCodexReasoningEffort', powerShellOptional(configuration.codex.reasoningEffort)],
    );
  }
  const lines = assignments.map(([name, value]) => `${name} = ${value}`);
  return `Set-PSDebug -Off\n${lines.join('\n')}\n`;
};
