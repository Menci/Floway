<script setup lang="ts">
import { computed, reactive, shallowRef, watchEffect } from 'vue';

import type { ApiKey, ControlPlaneModel } from '../../api/types.ts';
import {
  claudeModelOverride,
  isClaudeCodeModel,
  isCodexConfigModel,
  rankAgentSetupModels,
} from '../../lib/agent-setup-models.ts';
import { Code } from '@floway-dev/ui';

const props = defineProps<{
  agent: 'claude' | 'codex';
  apiKey: ApiKey;
  models: readonly ControlPlaneModel[];
}>();

const CLAUDE_TIER_KEYS = ['fable', 'opus', 'sonnet', 'haiku'] as const;
type ClaudeTierKey = typeof CLAUDE_TIER_KEYS[number];
const CLAUDE_TIER_LABELS: Record<ClaudeTierKey, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };

const claudeModelsByTier = computed<Record<ClaudeTierKey, string[]>>(() => Object.fromEntries(
  CLAUDE_TIER_KEYS.map(tier => [
    tier,
    rankAgentSetupModels(props.models, { family: 'claude', picker: tier })
      .filter(model => isClaudeCodeModel(model.id))
      .map(model => model.id),
  ]),
) as Record<ClaudeTierKey, string[]>);
const codexModels = computed(() => rankAgentSetupModels(props.models, { family: 'codex' })
  .filter(model => isCodexConfigModel(model.id))
  .map(model => model.id));

const claudeSelection = reactive<Record<ClaudeTierKey, string>>({ fable: '', opus: '', sonnet: '', haiku: '' });
const codexModel = shallowRef('');
watchEffect(() => {
  for (const tier of CLAUDE_TIER_KEYS) {
    if (!claudeModelsByTier.value[tier].includes(claudeSelection[tier])) {
      claudeSelection[tier] = claudeModelsByTier.value[tier][0] ?? '';
    }
  }
  if (!codexModels.value.includes(codexModel.value)) codexModel.value = codexModels.value[0] ?? '';
});

const claudeModelsById = computed(() => new Map(props.models.map(model => [model.id, model])));
const selectedClaudeModel = (tier: ClaudeTierKey): string => {
  const id = claudeSelection[tier];
  const model = claudeModelsById.value.get(id);
  return model === undefined ? id : claudeModelOverride(model.id, model.limits, tier);
};

const baseUrl = window.location.origin;
const claudeSnippet = computed(() => JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: props.apiKey.key,
    ANTHROPIC_DEFAULT_FABLE_MODEL: selectedClaudeModel('fable'),
    ANTHROPIC_DEFAULT_OPUS_MODEL: selectedClaudeModel('opus'),
    ANTHROPIC_DEFAULT_SONNET_MODEL: selectedClaudeModel('sonnet'),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedClaudeModel('haiku'),
  },
}, null, 2));

// The marker selects Codex's client-owned tools for this custom provider, and
// command auth also opts the provider into online model refresh.
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/model-provider-info/src/lib.rs#L396-L408
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/models-manager/src/manager.rs#L413-L415
// standalone_web_search is under development, so its explicit opt-in is paired
// with the top-level warning suppression instead of warning every run.
// https://github.com/openai/codex/blob/24e9b849fad8f506971dfa0313dbdea8abd90112/codex-rs/features/src/lib.rs#L901-L905
// https://github.com/openai/codex/blob/24e9b849fad8f506971dfa0313dbdea8abd90112/codex-rs/features/src/lib.rs#L1393-L1439
const codexSnippet = computed(() => [
  `model = "${codexModel.value}"`,
  'model_provider = "floway"',
  'suppress_unstable_features_warning = true',
  '',
  '[model_providers.floway]',
  'name = "Floway"',
  `base_url = "${baseUrl}/azure-api.codex"`,
  'auth = { command = "sh", args = ["-c", "cat \\"${CODEX_HOME:-$HOME/.codex}/floway-token\\""] } # Linux & macOS',
  `# auth = { command = "powershell", args = ["-NoProfile", "-Command", "$h = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }; [IO.File]::ReadAllText((Join-Path $h 'floway-token'))"] } # Windows: uncomment and remove the line above`,
  'wire_api = "responses"',
  'supports_websockets = true',
  'http_headers = { "x-openai-actor-authorization" = "1" }',
  '',
  '[features]',
  'apps = false',
  'standalone_web_search = true',
].join('\n'));

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

const selectClass = 'max-w-full rounded-lg border border-white/10 bg-surface-800 px-2 py-1.5 font-mono text-xs text-gray-300 outline-none focus:border-accent-cyan/50';
</script>

<template>
  <div class="space-y-8">
    <section v-if="agent === 'claude'">
      <h3 class="mb-3 text-sm font-semibold text-white">Claude Code</h3>
      <div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label v-for="tier in CLAUDE_TIER_KEYS" :key="tier" class="flex min-w-0 items-center gap-2 text-xs text-gray-500">
          <span>{{ CLAUDE_TIER_LABELS[tier] }}</span>
          <select v-model="claudeSelection[tier]" :class="selectClass">
            <option v-for="model in claudeModelsByTier[tier]" :key="model" :value="model">{{ model }}</option>
          </select>
        </label>
      </div>
      <p class="mb-2 text-[11px] text-gray-600">
        Edit <code class="text-gray-500">~/.claude/settings.json</code> and merge this JSON object. Do not export these values as shell environment variables.
      </p>
      <Code :code="claudeSnippet" language="json" />
    </section>

    <section v-else>
      <h3 class="mb-3 text-sm font-semibold text-white">Codex</h3>
      <label class="mb-3 flex max-w-sm items-center gap-2 text-xs text-gray-500">
        <span>Model</span>
        <select v-model="codexModel" :class="selectClass">
          <option v-for="model in codexModels" :key="model" :value="model">{{ model }}</option>
        </select>
      </label>
      <p class="mb-2 text-[11px] text-gray-600">Merge into <code class="text-gray-500">~/.codex/config.toml</code></p>
      <Code :code="codexSnippet" language="toml" />

      <p class="mb-2 mt-4 text-[11px] text-gray-600">Linux &amp; macOS provider token</p>
      <Code :code="codexUnixCredentialCommand" language="bash" />

      <p class="mb-2 mt-4 text-[11px] text-gray-600">Windows PowerShell provider token</p>
      <Code :code="codexWindowsCredentialCommand" language="powershell" />
    </section>
  </div>
</template>
