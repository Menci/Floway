<script setup lang="ts">
import { computed, reactive, shallowRef, watchEffect } from 'vue';

import type { ApiKey, ControlPlaneModel } from '../../api/types.ts';
import { Code } from '@floway-dev/ui';

const props = defineProps<{
  keys: readonly ApiKey[];
  models: readonly ControlPlaneModel[];
}>();

const selectedKeyId = shallowRef('');
watchEffect(() => {
  if (!props.keys.some(key => key.id === selectedKeyId.value)) {
    selectedKeyId.value = props.keys[0]?.id ?? '';
  }
});
const selectedKey = computed(() => props.keys.find(key => key.id === selectedKeyId.value) ?? null);

const CLAUDE_TIER_KEYS = ['fable', 'opus', 'sonnet', 'haiku'] as const;
type ClaudeTierKey = typeof CLAUDE_TIER_KEYS[number];
const CLAUDE_TIER: Record<ClaudeTierKey, number> = { fable: 0, opus: 1, sonnet: 2, haiku: 3 };
const CLAUDE_TIER_LABELS: Record<ClaudeTierKey, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const claudeTier = (id: string): number => {
  for (const tier of CLAUDE_TIER_KEYS) if (id.includes(tier)) return CLAUDE_TIER[tier];
  return 99;
};
const sortByTierDistance = (target: number) => (a: string, b: string): number => {
  const distance = Math.abs(claudeTier(a) - target) - Math.abs(claudeTier(b) - target);
  return distance === 0 ? b.localeCompare(a) : distance;
};
const sortCodex = (a: string, b: string): number => {
  const mini = Number(a.includes('mini')) - Number(b.includes('mini'));
  return mini === 0 ? b.localeCompare(a) : mini;
};
const isChat = (model: ControlPlaneModel): boolean => model.kind === 'chat';
const dedupe = (ids: string[]): string[] => [...new Set(ids)];
const CLAUDE_RE = /(^|\/)claude-/;
const CODEX_RE = /(^|\/)gpt-5/;

const claudeIds = computed(() => dedupe(props.models.filter(model => CLAUDE_RE.test(model.id) && isChat(model)).map(model => model.id)));
const codexIds = computed(() => dedupe(props.models.filter(model => CODEX_RE.test(model.id) && isChat(model)).map(model => model.id)));
const claudeModelsByTier = computed<Record<ClaudeTierKey, string[]>>(() => Object.fromEntries(
  CLAUDE_TIER_KEYS.map(tier => [tier, [...claudeIds.value].sort(sortByTierDistance(CLAUDE_TIER[tier]))]),
) as Record<ClaudeTierKey, string[]>);
const codexModels = computed(() => [...codexIds.value].sort(sortCodex));

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

const contextById = computed(() => new Map(props.models
  .filter(model => CLAUDE_RE.test(model.id) && isChat(model))
  .map(model => [model.id, model.limits?.max_context_window_tokens
    ?? ((model.limits?.max_prompt_tokens ?? 0) + (model.limits?.max_output_tokens ?? 0))])));
const withLargeContext = (id: string): string => (contextById.value.get(id) ?? 0) >= 1_000_000 ? `${id}[1m]` : id;

const baseUrl = window.location.origin;
const claudeSnippet = computed(() => JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: selectedKey.value?.key ?? '',
    ANTHROPIC_DEFAULT_FABLE_MODEL: withLargeContext(claudeSelection.fable),
    ANTHROPIC_DEFAULT_OPUS_MODEL: withLargeContext(claudeSelection.opus),
    ANTHROPIC_DEFAULT_SONNET_MODEL: withLargeContext(claudeSelection.sonnet),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: claudeSelection.haiku,
  },
}, null, 2));

// The marker selects Codex's client-owned tools for this custom provider, and
// command auth also opts the provider into online model refresh.
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/model-provider-info/src/lib.rs#L396-L408
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/models-manager/src/manager.rs#L413-L415
const codexSnippet = computed(() => [
  `model = "${codexModel.value}"`,
  'model_provider = "floway"',
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
  const apiKey = `'${(selectedKey.value?.key ?? '').replaceAll("'", `'"'"'`)}'`;
  return [
    'codex_home="${CODEX_HOME:-$HOME/.codex}"',
    'mkdir -p "$codex_home" && \\',
    `  printf '%s' ${apiKey} > "$codex_home/floway-token" && \\`,
    '  chmod 600 "$codex_home/floway-token"',
  ].join('\n');
});
const codexWindowsCredentialCommand = computed(() => {
  const apiKey = `'${(selectedKey.value?.key ?? '').replaceAll("'", "''")}'`;
  return [
    '$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }',
    'New-Item -ItemType Directory -Force -Path $codexHome | Out-Null',
    `[IO.File]::WriteAllText((Join-Path $codexHome "floway-token"), ${apiKey}, (New-Object Text.UTF8Encoding($false)))`,
  ].join('\n');
});

const selectClass = 'max-w-full rounded-lg border border-white/10 bg-surface-800 px-2 py-1.5 font-mono text-xs text-gray-300 outline-none focus:border-accent-cyan/50';
</script>

<template>
  <div v-if="selectedKey" class="space-y-8">
    <label class="block max-w-sm text-xs text-gray-500">
      <span class="mb-1.5 block">API key</span>
      <select v-model="selectedKeyId" :class="selectClass" class="w-full">
        <option v-for="key in keys" :key="key.id" :value="key.id">{{ key.name }}</option>
      </select>
    </label>

    <section>
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

    <section class="border-t border-white/5 pt-8">
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
      <Code :code="codexWindowsCredentialCommand" language="text" />
    </section>
  </div>

  <div v-else class="rounded-lg border border-white/10 bg-surface-800/60 px-4 py-6 text-center text-sm text-gray-400">
    Create an API key above to generate configuration snippets.
  </div>
</template>
