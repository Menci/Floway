import type { InferResponseType } from 'hono/client';

import { addressVSCodeModels, type VSCodeModel, type ZedModel } from './agent-setup-models';
import type { api } from '../../api/client';
import { ZED_CREDENTIAL_CSHARP } from '@floway-dev/agent-setup/zed-credential';

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
    disableAutoMemory: false,
    disableAgentView: false,
    modelDiscovery: true,
  },
  codex: { model: null, reasoningEffort: null },
  zed: { providerName: 'Floway' },
  vscode: { providerName: 'Floway', apiType: 'messages' },
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
  copyChangedFields(merged.vscode, local.vscode, baseline.vscode);
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
  ...(settings.disableAutoMemory ? { autoMemoryEnabled: false } : {}),
  ...(settings.disableAgentView ? { disableAgentView: true } : {}),
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
  models: readonly ZedModel[],
) => JSON.stringify({
  language_models: {
    anthropic_compatible: {
      [config.providerName]: { api_url: origin, available_models: models },
    },
  },
}, null, 2);

// Zed reads the key from the OS credential store, indexed by api_url under the
// fixed username "Bearer"; there is no settings field for it. On macOS that is
// an internet password whose server is the url and whose account is the
// username — what `-s` and `-a` set. The Secret Service label is compared
// exactly on read, so it is a literal.
// Refs: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/gpui_macos/src/platform.rs#L1151-L1170
//       https://github.com/zed-industries/zed/issues/43671
export const zedUnixCredentialSnippet = (origin: string, apiKey: string) => {
  const quotedKey = `'${apiKey.replaceAll("'", `'"'"'`)}'`;
  const quotedUrl = `'${origin.replaceAll("'", `'"'"'`)}'`;
  return [
    // The Darwin arm runs in a subshell: unlike the installer's function, a
    // pasted script sets positional parameters in the operator's own shell,
    // where they would outlive the paste still holding the key.
    'if [ "$(uname -s)" = Darwin ]; then (',
    // -T fails the whole call on a path that does not exist, so only bundles
    // present on this host are named; naming none still stores the item.
    `  set -- -s ${quotedUrl} -a Bearer -U -w ${quotedKey}`,
    '  for app in /Applications/Zed.app "$HOME/Applications/Zed.app" \\',
    '      "/Applications/Zed Preview.app" "$HOME/Applications/Zed Preview.app" \\',
    '      "/Applications/Zed Nightly.app" "$HOME/Applications/Zed Nightly.app"; do',
    '    [ -d "$app" ] && set -- "$@" -T "$app"',
    '  done',
    '  security add-internet-password "$@"',
    '); else',
    `  printf '%s' ${quotedKey} | secret-tool store --label=zed-github-account url ${quotedUrl} username Bearer`,
    'fi',
  ].join('\n');
};

// Windows keeps it as a generic credential whose target name Zed builds as
// "zed:url=" + api_url. The blob must be UTF-8 because Zed runs str::from_utf8
// over it, which rules out cmdkey — that writes UTF-16LE.
// Ref: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/gpui_windows/src/util.rs#L89-L91
export const zedWindowsCredentialSnippet = (origin: string, apiKey: string) => {
  const quotedKey = `'${apiKey.replaceAll("'", "''")}'`;
  const quotedTarget = `'${`zed:url=${origin}`.replaceAll("'", "''")}'`;
  return [
    // An operator pastes this again after rotating the key or renaming the
    // provider. Add-Type accepts a byte-identical re-add by returning its
    // cached type and rejects any source that differs under a name already in
    // the AppDomain, so the guard makes the second paste a no-op outright
    // rather than resting on that cache.
    //
    // The body is the installer's own, not a copy of it. Both define
    // FlowayZedCredential and both guard the same way, so in a console where
    // one has already run the other silently gets whichever version got there
    // first — a snippet that differed by so much as where it zeroes the freed
    // blob would disable the installer's scrubbing with nothing to show for it.
    `if (-not ('FlowayZedCredential' -as [type])) {`,
    // A literal here-string, as the installer uses: `@"` interpolates, so a `$`
    // or a backtick reaching the shared C# would expand here and not there,
    // leaving one type name with two different bodies — the outcome the sharing
    // above exists to prevent. The body carries neither today, which is why
    // this is the difference between the two that matters.
    "Add-Type -TypeDefinition @'",
    ZED_CREDENTIAL_CSHARP.trimEnd(),
    "'@",
    '}',
    `[FlowayZedCredential]::Write(${quotedTarget}, 'Bearer', [Text.Encoding]::UTF8.GetBytes(${quotedKey}))`,
  ].join('\n');
};

// VS Code's provider list is a top-level array of groups, so the array wrapper
// here is the file's own shape: pasted into an empty file it is the whole
// document, and into an existing one the single entry is what goes in beside
// whatever other gateways the operator configured.
//
// Beside the others, but not beside another group of this name. A model is
// identified as `${vendor}/${group}/${id}`, so two groups sharing a name
// produce the same identifiers and the second registration is skipped with a
// log line — its models, endpoint and key never take effect. Per-model
// `settings` are the one part read the other way round, from every matching
// group in order, so the later group's win. An operator who pastes this beside
// an entry they already have therefore gets nothing, which is why the hint
// beside it says to replace that entry rather than add to it.
// Refs: https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/workbench/api/common/extHostLanguageModels.ts#L173-L174
//       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/workbench/contrib/chat/common/languageModels.ts#L1281-L1289
//       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/workbench/contrib/chat/common/languageModels.ts#L1211-L1214
//       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/workbench/contrib/chat/common/languageModels.ts#L1252-L1262
// A pasted snippet has no merge to attach the endpoint and the credential, so
// it carries them — through the same rule the installers implement, stated once
// in the shared module rather than a second time here.
export const buildAgentVSCodeSnippet = (
  origin: string,
  apiKey: string,
  config: AgentSetupConfiguration['vscode'],
  models: readonly VSCodeModel[],
) => JSON.stringify([{
  vendor: 'customendpoint',
  name: config.providerName,
  apiType: config.apiType,
  models: addressVSCodeModels(models, origin, apiKey),
}], null, 2);
