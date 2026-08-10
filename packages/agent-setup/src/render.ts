// Renders the language-native assignment prefix prepended to the fixed,
// checked-in installer body in every setup-script response. Every external
// value (the API key and each opaque model/effort string) is emitted through a
// single-quoted literal encoder, so quotes, whitespace, or shell metacharacters
// can never break out of an assignment — the real injection defense. The
// gateway never renders its own public origin: the dashboard injects it into
// the executing shell, and the fixed installer body reads it from there.

import type { AgentSetupConfiguration } from './configuration.ts';
import type { VSCodeModel, ZedModel } from './models.ts';
import type { ScriptAgent } from './script-assets.ts';

export interface RenderPrefixInput {
  agent: ScriptAgent;
  apiKey: string;
  apiKeyName: string;
  configuration: AgentSetupConfiguration;
  // The catalog projected for the editor agents, which snapshot it at setup
  // time. Absent for the CLI agents, which discover models themselves.
  editorModels?: readonly ZedModel[] | readonly VSCodeModel[];
}

const assertNoNul = (value: string): void => {
  if (value.includes('\0')) throw new Error('cannot render a value containing a NUL character');
};

// Flatten every C0/DEL control byte to a space so a key label cannot smuggle a
// terminal escape into the metadata assignment. The value still flows through a
// literal encoder afterward, which is where a NUL is rejected.
const metadataValue = (value: string): string => value.replace(/[\u0001-\u001f\u007f]/g, ' ');

// The projected catalog, serialized once for whichever shell is rendering it.
// Compact rather than indented: this is machine input the installer hands
// straight to its merge, and every byte rides in a credential-bearing response.
// An editor agent with no projection is a wiring mistake in the host, not an
// empty catalog — the route refuses to serve a script it cannot fill.
const editorModelsJson = ({ agent, editorModels }: RenderPrefixInput): string => {
  if (editorModels === undefined) throw new Error(`no projected models supplied for ${agent}`);
  return JSON.stringify(editorModels);
};

// A script that reports why it cannot run and exits non-zero. The editor agents
// need the catalog rendered into them, so a listing failure has to be answered
// with something the operator can read: an opaque 404 would look like a broken
// setup link, and a 500 like a gateway fault. The detail stays in the server
// log — this response is unauthenticated apart from the token in its URL.
export const renderScriptFailure = (language: 'sh' | 'ps1', message: string): string => (language === 'sh'
  // `curl | sh` runs in its own process, so exiting is contained. The
  // PowerShell invocation is `irm … | iex` in the operator's own console, which
  // `exit` would close — taking the message this script exists to show with it.
  // The installers set $global:LASTEXITCODE and return for the same reason.
  ? `printf '%s\\n' ${shellLiteral(message)} >&2\nexit 1\n`
  : `Write-Error ${powerShellLiteral(message)}\n$global:LASTEXITCODE = 1\n`);

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
const shellOptionalNumber = (value: number | null): string => value?.toString() ?? '';

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
      ['SETUP_CLAUDE_DEFAULT_FABLE_MODEL', shellOptional(claudeCode.defaultFableModel)],
      ['SETUP_CLAUDE_DEFAULT_OPUS_MODEL', shellOptional(claudeCode.defaultOpusModel)],
      ['SETUP_CLAUDE_DEFAULT_SONNET_MODEL', shellOptional(claudeCode.defaultSonnetModel)],
      ['SETUP_CLAUDE_DEFAULT_HAIKU_MODEL', shellOptional(claudeCode.defaultHaikuModel)],
      ['SETUP_CLAUDE_EFFORT_LEVEL', shellOptional(claudeCode.effortLevel)],
      ['SETUP_CLAUDE_CLEANUP_PERIOD_DAYS', shellOptionalNumber(claudeCode.cleanupPeriodDays)],
      ['SETUP_CLAUDE_OPT_OUT_AI_ATTRIBUTION', shellFlag(claudeCode.optOutAiAttribution)],
      ['SETUP_CLAUDE_DISABLE_AUTO_MEMORY', shellFlag(claudeCode.disableAutoMemory)],
      ['SETUP_CLAUDE_DISABLE_AGENT_VIEW', shellFlag(claudeCode.disableAgentView)],
      ['SETUP_CLAUDE_MODEL_DISCOVERY', shellFlag(claudeCode.modelDiscovery)],
    );
  } else if (agent === 'zed') {
    assignments.push(
      ['SETUP_ZED_PROVIDER_NAME', configuration.zed.providerName],
      ['SETUP_ZED_MODELS', editorModelsJson(input)],
    );
  } else if (agent === 'vscode') {
    assignments.push(
      ['SETUP_VSCODE_PROVIDER_NAME', configuration.vscode.providerName],
      ['SETUP_VSCODE_API_TYPE', configuration.vscode.apiType],
      ['SETUP_VSCODE_MODELS', editorModelsJson(input)],
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
const powerShellOptionalNumber = (value: number | null): string => value?.toString() ?? '$null';

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
      ['$SetupClaudeDefaultFableModel', powerShellOptional(claudeCode.defaultFableModel)],
      ['$SetupClaudeDefaultOpusModel', powerShellOptional(claudeCode.defaultOpusModel)],
      ['$SetupClaudeDefaultSonnetModel', powerShellOptional(claudeCode.defaultSonnetModel)],
      ['$SetupClaudeDefaultHaikuModel', powerShellOptional(claudeCode.defaultHaikuModel)],
      ['$SetupClaudeEffortLevel', powerShellOptional(claudeCode.effortLevel)],
      ['$SetupClaudeCleanupPeriodDays', powerShellOptionalNumber(claudeCode.cleanupPeriodDays)],
      ['$SetupClaudeOptOutAiAttribution', powerShellBool(claudeCode.optOutAiAttribution)],
      ['$SetupClaudeDisableAutoMemory', powerShellBool(claudeCode.disableAutoMemory)],
      ['$SetupClaudeDisableAgentView', powerShellBool(claudeCode.disableAgentView)],
      ['$SetupClaudeModelDiscovery', powerShellBool(claudeCode.modelDiscovery)],
    );
  } else if (agent === 'zed') {
    assignments.push(
      ['$SetupZedProviderName', powerShellLiteral(configuration.zed.providerName)],
      ['$SetupZedModels', powerShellLiteral(editorModelsJson(input))],
    );
  } else if (agent === 'vscode') {
    assignments.push(
      ['$SetupVSCodeProviderName', powerShellLiteral(configuration.vscode.providerName)],
      ['$SetupVSCodeApiType', powerShellLiteral(configuration.vscode.apiType)],
      ['$SetupVSCodeModels', powerShellLiteral(editorModelsJson(input))],
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
