import type { InferResponseType } from 'hono/client';

import type { AgentSetupZedModel } from './agent-setup-models';
import type { api } from '../../api/client';

export type AgentSetupLease = Extract<InferResponseType<typeof api.api.setup.$put>, { status: 'ok' }>;
export type AgentSetupConfiguration = AgentSetupLease['configuration'];

// What the form is edited into before a lease answers. The gateway authors the
// real first-use configuration and the dashboard never sees that code — types
// cross this boundary, values do not — so the field set here is held to the
// contract by the annotation: a field added or dropped server-side fails this
// literal to compile. The values only decide what the fields render in the
// seconds before a lease arrives, and they cannot reach a saved configuration,
// because applyLocalAgentSetupChanges measures the draft against this same
// object and copies nothing that was left alone.
export const blankAgentSetupDraft = (): AgentSetupConfiguration => ({
  apiKeyId: '',
  claudeCode: {
    model: null,
    defaultFableModel: null,
    defaultOpusModel: null,
    defaultSonnetModel: null,
    defaultHaikuModel: null,
    effortLevel: null,
    cleanupPeriodDays: null,
    optOutAiAttribution: false,
    modelDiscovery: true,
  },
  codex: { model: null, reasoningEffort: null },
  zed: { providerName: 'Floway' },
});

export const cloneAgentSetupConfiguration = (
  configuration: AgentSetupConfiguration,
): AgentSetupConfiguration => structuredClone(configuration);

export type AgentSetupPlatform = 'unix' | 'windows';

export const detectAgentSetupPlatform = (
  platform: string,
  userAgent: string,
): AgentSetupPlatform => /windows|win32|win64|wince/i.test(`${platform} ${userAgent}`)
  ? 'windows'
  : 'unix';

const copyChangedFields = <T extends object>(target: T, current: T, baseline: T) => {
  for (const key of Object.keys(current) as (keyof T)[]) {
    if (!Object.is(current[key], baseline[key])) target[key] = current[key];
  }
};

export const applyLocalAgentSetupChanges = (
  server: AgentSetupConfiguration,
  local: AgentSetupConfiguration,
  baseline: AgentSetupConfiguration,
): AgentSetupConfiguration => {
  const merged = cloneAgentSetupConfiguration(server);
  copyChangedFields(merged.claudeCode, local.claudeCode, baseline.claudeCode);
  copyChangedFields(merged.codex, local.codex, baseline.codex);
  copyChangedFields(merged.zed, local.zed, baseline.zed);
  return merged;
};

export const codexUnixCredentialSnippet = (apiKey: string) => {
  const quoted = `'${apiKey.replaceAll("'", `'"'"'`)}'`;
  return [
    'codex_home="${CODEX_HOME:-$HOME/.codex}"',
    'mkdir -p "$codex_home" && \\',
    `  printf '%s' ${quoted} > "$codex_home/floway-token" && \\`,
    '  chmod 600 "$codex_home/floway-token"',
  ].join('\n');
};

export const codexWindowsCredentialSnippet = (apiKey: string) => {
  const quoted = `'${apiKey.replaceAll("'", "''")}'`;
  return [
    '$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }',
    'New-Item -ItemType Directory -Force -Path $codexHome | Out-Null',
    `[IO.File]::WriteAllText((Join-Path $codexHome "floway-token"), ${quoted}, (New-Object Text.UTF8Encoding($false)))`,
  ].join('\n');
};

// Empty strings suppress commit/PR attribution; false suppresses session links.
// https://code.claude.com/docs/en/settings#attribution-settings
const claudeAttributionOptOut = { commit: '', pr: '', sessionUrl: false } as const;

export const buildAgentClaudeSnippet = (
  origin: string,
  apiKey: string,
  settings: AgentSetupConfiguration['claudeCode'],
) => JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: origin,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ...(settings.model ? { ANTHROPIC_MODEL: settings.model } : {}),
    ...(settings.defaultFableModel ? { ANTHROPIC_DEFAULT_FABLE_MODEL: settings.defaultFableModel } : {}),
    ...(settings.defaultOpusModel ? { ANTHROPIC_DEFAULT_OPUS_MODEL: settings.defaultOpusModel } : {}),
    ...(settings.defaultSonnetModel ? { ANTHROPIC_DEFAULT_SONNET_MODEL: settings.defaultSonnetModel } : {}),
    ...(settings.defaultHaikuModel ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: settings.defaultHaikuModel } : {}),
    ...(settings.modelDiscovery ? { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' } : {}),
  },
  ...(settings.effortLevel ? { effortLevel: settings.effortLevel } : {}),
  ...(settings.cleanupPeriodDays === null ? {} : { cleanupPeriodDays: settings.cleanupPeriodDays }),
  ...(settings.optOutAiAttribution ? { attribution: claudeAttributionOptOut } : {}),
}, null, 2);

// JSON string literals are valid TOML basic strings, so JSON.stringify keeps
// opaque model values lossless. https://toml.io/en/v1.0.0#string
// x-openai-actor-authorization enables Codex-owned web search and image generation;
// command auth also enables live model refresh:
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/model-provider-info/src/lib.rs#L396-L408
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/ext/web-search/src/extension.rs#L41-L46
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/ext/image-generation/src/extension.rs#L38-L45
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/models-manager/src/manager.rs#L413-L415
// Apps is ChatGPT-only; standalone web search requires explicit warning suppression:
// https://github.com/openai/codex/blob/24e9b849fad8f506971dfa0313dbdea8abd90112/codex-rs/features/src/lib.rs#L382-L384
// https://github.com/openai/codex/blob/24e9b849fad8f506971dfa0313dbdea8abd90112/codex-rs/features/src/lib.rs#L901-L905
// https://github.com/openai/codex/blob/24e9b849fad8f506971dfa0313dbdea8abd90112/codex-rs/features/src/lib.rs#L1393-L1439
// The auth command reads the token file the credential snippet writes, so the
// two halves of the Codex setup are one platform's pair: a shell that can read
// it, and a shell that wrote it.
export const buildAgentCodexSnippet = (origin: string, config: AgentSetupConfiguration['codex'], platform: 'unix' | 'windows') => [
  ...(config.model ? [`model = ${JSON.stringify(config.model)}`] : []),
  ...(config.reasoningEffort ? [`model_reasoning_effort = ${JSON.stringify(config.reasoningEffort)}`] : []),
  'model_provider = "floway"',
  'suppress_unstable_features_warning = true',
  '',
  '[model_providers.floway]',
  'name = "Floway"',
  `base_url = ${JSON.stringify(`${origin}/azure-api.codex`)}`,
  platform === 'windows'
    ? 'auth = { command = "powershell", args = ["-NoProfile", "-Command", "$h = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME \'.codex\' }; [IO.File]::ReadAllText((Join-Path $h \'floway-token\'))"] }'
    : 'auth = { command = "sh", args = ["-c", "cat \\"${CODEX_HOME:-$HOME/.codex}/floway-token\\""] }',
  'wire_api = "responses"',
  'supports_websockets = true',
  'http_headers = { "x-openai-actor-authorization" = "1" }',
  '',
  '[features]',
  'apps = false',
  'standalone_web_search = true',
].join('\n');

// Zed's provider list lives in `global_settings.json`, a layer it reads below
// the user's own settings and never writes to, so pasting this replaces the
// whole file rather than merging into a document the editor also owns.
// The api_url is the bare origin: Zed appends `/v1/messages` itself.
// Ref: https://github.com/zed-industries/zed/pull/30444
export const buildAgentZedSnippet = (
  origin: string,
  config: AgentSetupConfiguration['zed'],
  models: readonly AgentSetupZedModel[],
) => JSON.stringify({
  language_models: {
    anthropic_compatible: {
      [config.providerName]: { api_url: origin, available_models: models },
    },
  },
}, null, 2);

// Zed reads the key from the OS credential store, indexed by api_url under the
// fixed username "Bearer"; there is no settings field for it. The Secret
// Service label is compared exactly on read, so it is a literal.
// Ref: https://github.com/zed-industries/zed/issues/43671
export const zedUnixCredentialSnippet = (origin: string, apiKey: string) => {
  const quotedKey = `'${apiKey.replaceAll("'", `'"'"'`)}'`;
  const quotedUrl = `'${origin.replaceAll("'", `'"'"'`)}'`;
  return [
    'if [ "$(uname -s)" = Darwin ]; then',
    `  security add-internet-password -s ${quotedUrl} -a Bearer -w ${quotedKey} -U -T /Applications/Zed.app`,
    'else',
    `  secret-tool clear url ${quotedUrl} username Bearer 2>/dev/null`,
    `  printf '%s' ${quotedKey} | secret-tool store --label=zed-github-account url ${quotedUrl} username Bearer`,
    'fi',
  ].join('\n');
};

// Windows keeps it as a generic credential whose target name Zed builds as
// "zed:url=" + api_url. The blob must be UTF-8 because Zed runs str::from_utf8
// over it, which rules out cmdkey — that writes UTF-16LE.
export const zedWindowsCredentialSnippet = (origin: string, apiKey: string) => {
  const quotedKey = `'${apiKey.replaceAll("'", "''")}'`;
  const quotedTarget = `'${`zed:url=${origin}`.replaceAll("'", "''")}'`;
  return [
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class ZedCred {',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '  private struct CREDENTIAL {',
    '    public uint Flags; public uint Type; public string TargetName; public string Comment;',
    '    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
    '    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;',
    '    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;',
    '  }',
    '  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  private static extern bool CredWriteW(ref CREDENTIAL c, uint f);',
    '  public static void Write(string target, string user, byte[] secret) {',
    '    IntPtr blob = Marshal.AllocHGlobal(secret.Length);',
    '    try {',
    '      Marshal.Copy(secret, 0, blob, secret.Length);',
    '      CREDENTIAL c = new CREDENTIAL();',
    '      c.Type = 1; c.TargetName = target; c.CredentialBlobSize = (uint)secret.Length;',
    '      c.CredentialBlob = blob; c.Persist = 2; c.UserName = user;',
    '      if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());',
    '    } finally { Marshal.FreeHGlobal(blob); }',
    '  }',
    '}',
    '"@',
    `[ZedCred]::Write(${quotedTarget}, 'Bearer', [Text.Encoding]::UTF8.GetBytes(${quotedKey}))`,
  ].join('\n');
};
