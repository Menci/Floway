<script setup lang="ts">
import { computed } from 'vue';

import type { ApiKey } from '../../api/types.ts';
import type { AgentSetupConfiguration } from '../../composables/useAgentSetup.ts';
import { Code } from '@floway-dev/ui';

const props = defineProps<{
  agent: 'claude' | 'codex';
  apiKey: ApiKey;
  configuration: AgentSetupConfiguration;
}>();

const baseUrl = window.location.origin;
// Claude uses empty strings to suppress commit/PR attribution and a boolean
// false to suppress session links.
// Ref: https://code.claude.com/docs/en/settings#attribution-settings
const attributionOptOut = { commit: '', pr: '', sessionUrl: false } as const;
const claudeSnippet = computed(() => {
  const settings = props.configuration.claudeCode;
  return JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: props.apiKey.key,
      ...(settings.model === null ? {} : { ANTHROPIC_MODEL: settings.model }),
      ...(settings.defaultOpusModel === null ? {} : { ANTHROPIC_DEFAULT_OPUS_MODEL: settings.defaultOpusModel }),
      ...(settings.defaultSonnetModel === null ? {} : { ANTHROPIC_DEFAULT_SONNET_MODEL: settings.defaultSonnetModel }),
      ...(settings.defaultHaikuModel === null ? {} : { ANTHROPIC_DEFAULT_HAIKU_MODEL: settings.defaultHaikuModel }),
      ...(settings.modelDiscovery ? { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' } : {}),
    },
    ...(settings.effortLevel === null ? {} : { effortLevel: settings.effortLevel }),
    ...(settings.cleanupPeriodDays === null ? {} : { cleanupPeriodDays: settings.cleanupPeriodDays }),
    ...(settings.optOutAiAttribution ? { attribution: attributionOptOut } : {}),
  }, null, 2);
});

// A JSON string literal is a valid TOML basic string: TOML basic strings accept
// the exact escape set JSON.stringify emits (\b \t \n \f \r \" \\ \uXXXX), so the
// serialized value transfers verbatim without re-escaping.
// Ref: https://toml.io/en/v1.0.0#string
const tomlString = (value: string): string => JSON.stringify(value);

// The marker selects Codex's client-owned tools for this custom provider, and
// command auth also opts the provider into online model refresh.
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/model-provider-info/src/lib.rs#L396-L408
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/models-manager/src/manager.rs#L413-L415
// The Apps surface defaults on but only takes effect under ChatGPT auth, so on
// this api-key provider it is redundant; disabling it explicitly keeps the
// provider free of the ChatGPT-only tool surface.
// https://github.com/openai/codex/blob/24e9b849fad8f506971dfa0313dbdea8abd90112/codex-rs/features/src/lib.rs#L1067-L1072
// https://github.com/openai/codex/blob/24e9b849fad8f506971dfa0313dbdea8abd90112/codex-rs/features/src/lib.rs#L382-L384
// standalone_web_search is under development, so its explicit opt-in is paired
// with the top-level warning suppression instead of warning every run.
// https://github.com/openai/codex/blob/24e9b849fad8f506971dfa0313dbdea8abd90112/codex-rs/features/src/lib.rs#L901-L905
// https://github.com/openai/codex/blob/24e9b849fad8f506971dfa0313dbdea8abd90112/codex-rs/features/src/lib.rs#L1393-L1439
const codexSnippet = computed(() => {
  const settings = props.configuration.codex;
  return [
    ...(settings.model === null ? [] : [`model = ${tomlString(settings.model)}`]),
    ...(settings.reasoningEffort === null ? [] : [`model_reasoning_effort = ${tomlString(settings.reasoningEffort)}`]),
    'model_provider = "floway"',
    'suppress_unstable_features_warning = true',
    '',
    '[model_providers.floway]',
    'name = "Floway"',
    `base_url = ${tomlString(`${baseUrl}/azure-api.codex`)}`,
    'auth = { command = "sh", args = ["-c", "cat \\"${CODEX_HOME:-$HOME/.codex}/floway-token\\""] } # Linux & macOS',
    `# auth = { command = "powershell", args = ["-NoProfile", "-Command", "$h = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }; [IO.File]::ReadAllText((Join-Path $h 'floway-token'))"] } # Windows: uncomment and remove the line above`,
    'wire_api = "responses"',
    'supports_websockets = true',
    'http_headers = { "x-openai-actor-authorization" = "1" }',
    '',
    '[features]',
    'apps = false',
    'standalone_web_search = true',
  ].join('\n');
});

const codexUnixCredentialCommand = computed(() => {
  const apiKey = `'${props.apiKey.key.replaceAll("'", `'"'"'`)}'`;
  return [
    'codex_home="${CODEX_HOME:-$HOME/.codex}"',
    'mkdir -p "$codex_home" && \\',
    `  printf '%s' ${apiKey} > "$codex_home/floway-token" && \\`,
    '  chmod 600 "$codex_home/floway-token"',
  ].join('\n');
});
const codexWindowsCredentialCommand = computed(() => {
  const apiKey = `'${props.apiKey.key.replaceAll("'", "''")}'`;
  return [
    '$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }',
    'New-Item -ItemType Directory -Force -Path $codexHome | Out-Null',
    `[IO.File]::WriteAllText((Join-Path $codexHome "floway-token"), ${apiKey}, (New-Object Text.UTF8Encoding($false)))`,
  ].join('\n');
});
</script>

<template>
  <div class="mt-5 border-t border-white/5 pt-5">
    <section v-if="agent === 'claude'">
      <p class="mb-2 text-[11px] text-gray-600">
        Edit <code class="text-gray-500">~/.claude/settings.json</code> and merge this JSON object. Do not export these values as shell environment variables.
      </p>
      <Code :code="claudeSnippet" language="json" />
    </section>

    <section v-else>
      <p class="mb-2 text-[11px] text-gray-600">Merge into <code class="text-gray-500">~/.codex/config.toml</code></p>
      <Code :code="codexSnippet" language="toml" />

      <p class="mb-2 mt-4 text-[11px] text-gray-600">Linux &amp; macOS provider token</p>
      <Code :code="codexUnixCredentialCommand" language="bash" />

      <p class="mb-2 mt-4 text-[11px] text-gray-600">Windows PowerShell provider token</p>
      <Code :code="codexWindowsCredentialCommand" language="powershell" />
    </section>
  </div>
</template>
