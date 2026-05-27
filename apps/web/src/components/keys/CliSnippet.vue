<script setup lang="ts">
import { Code } from '@floway-dev/ui';
import { computed, ref, watchEffect } from 'vue';

import type { ControlPlaneModel } from '../../api/types.ts';

const props = defineProps<{
  apiKey: string;
  models: ControlPlaneModel[];
}>();

const baseUrl = computed(() => (typeof window !== 'undefined' ? window.location.origin : ''));

// Picker buckets — Claude Code only accepts claude-* generation ids, Codex
// accepts gpt-* / codex-* generation ids. Backend already collapses dated /
// variant suffixes; dedupe by id and sort by family tier so the picker
// defaults land on the canonical Opus / Sonnet / Haiku per slot, mirroring
// the prerender dashboard (sortClaudeBig/Sonnet/Small in client.tsx).
const CLAUDE_TIER: Record<string, number> = { opus: 0, sonnet: 1, haiku: 2 };
const claudeTier = (id: string) => {
  for (const t of Object.keys(CLAUDE_TIER)) if (id.includes(t)) return CLAUDE_TIER[t]!;
  return 99;
};
const sortClaudeBig = (a: string, b: string) => {
  const ta = claudeTier(a), tb = claudeTier(b);
  return ta !== tb ? ta - tb : b.localeCompare(a);
};
const sortClaudeSmall = (a: string, b: string) => {
  const ta = claudeTier(a), tb = claudeTier(b);
  return ta !== tb ? tb - ta : b.localeCompare(a);
};
const sortClaudeSonnet = (a: string, b: string) => {
  const da = Math.abs(claudeTier(a) - CLAUDE_TIER.sonnet!);
  const db = Math.abs(claudeTier(b) - CLAUDE_TIER.sonnet!);
  return da !== db ? da - db : b.localeCompare(a);
};
const sortCodex = (a: string, b: string) => {
  const am = a.includes('mini') ? 1 : 0;
  const bm = b.includes('mini') ? 1 : 0;
  return am !== bm ? am - bm : b.localeCompare(a);
};

const isGeneration = (m: ControlPlaneModel) => m.kind !== 'embedding';
const dedupe = (arr: string[]) => [...new Set(arr)];

const claudeIds = computed(() => dedupe(props.models.filter(m => m.id.startsWith('claude-') && isGeneration(m)).map(m => m.id)));
const codexIds = computed(() => dedupe(props.models.filter(m => (m.id.startsWith('gpt-') || m.id.startsWith('codex-')) && isGeneration(m)).map(m => m.id)));

const claudeModelsBig = computed(() => [...claudeIds.value].sort(sortClaudeBig));
const claudeModelsSonnet = computed(() => [...claudeIds.value].sort(sortClaudeSonnet));
const claudeModelsSmall = computed(() => [...claudeIds.value].sort(sortClaudeSmall));
const codexModelsList = computed(() => [...codexIds.value].sort(sortCodex));

const claudeModel = ref('');
const claudeSonnetModel = ref('');
const claudeSmallModel = ref('');
const codexModel = ref('');

// Keep the selection valid as the model lists rehydrate: if the current pick
// disappears (e.g. an upstream toggled off), fall back to the bucket head.
watchEffect(() => {
  if (!claudeModelsBig.value.includes(claudeModel.value)) claudeModel.value = claudeModelsBig.value[0] ?? '';
  if (!claudeModelsSonnet.value.includes(claudeSonnetModel.value)) claudeSonnetModel.value = claudeModelsSonnet.value[0] ?? '';
  if (!claudeModelsSmall.value.includes(claudeSmallModel.value)) claudeSmallModel.value = claudeModelsSmall.value[0] ?? '';
  if (!codexModelsList.value.includes(codexModel.value)) codexModel.value = codexModelsList.value[0] ?? '';
});

// Per-id context-window lookup so Claude Code's ANTHROPIC_MODEL line can
// append the `[1m]` suffix when the upstream supports a 1M context.
const contextById = computed(() => {
  const map = new Map<string, number>();
  for (const m of props.models) {
    if (!m.id.startsWith('claude-') || !isGeneration(m)) continue;
    const lim = m.limits;
    const ctx = lim?.max_context_window_tokens ?? ((lim?.max_prompt_tokens ?? 0) + (lim?.max_output_tokens ?? 0));
    map.set(m.id, ctx);
  }
  return map;
});

const addCtx = (id: string) => (contextById.value.get(id) ?? 0) >= 1_000_000 ? `${id}[1m]` : id;

const claudeSnippet = computed(() => [
  `export ANTHROPIC_BASE_URL=${baseUrl.value}`,
  `export ANTHROPIC_AUTH_TOKEN=${props.apiKey}`,
  `export ANTHROPIC_MODEL=${addCtx(claudeModel.value)}`,
  `export ANTHROPIC_DEFAULT_SONNET_MODEL=${addCtx(claudeSonnetModel.value)}`,
  `export ANTHROPIC_DEFAULT_HAIKU_MODEL=${claudeSmallModel.value}`,
].join('\n'));

const codexSnippet = computed(() => [
  `model = "${codexModel.value}"`,
  'model_provider = "floway"',
  '',
  '[model_providers.floway]',
  'name = "Floway"',
  `base_url = "${baseUrl.value}/"`,
  'env_key = "FLOWAY_API_KEY"',
  'wire_api = "responses"',
].join('\n'));

const codexEnvSnippet = computed(() => `export FLOWAY_API_KEY=${props.apiKey}`);

const selectClass = 'max-w-full text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer';
</script>

<template>
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
    <div>
      <div class="mb-3">
        <span class="text-sm font-semibold text-white">Claude Code</span>
      </div>

      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
        <div class="flex min-w-0 items-center gap-2">
          <label class="text-xs text-gray-500">Model:</label>
          <select v-model="claudeModel" :class="selectClass">
            <option v-for="m in claudeModelsBig" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
        <div class="flex min-w-0 items-center gap-2">
          <label class="text-xs text-gray-500">Sonnet:</label>
          <select v-model="claudeSonnetModel" :class="selectClass">
            <option v-for="m in claudeModelsSonnet" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
        <div class="flex min-w-0 items-center gap-2">
          <label class="text-xs text-gray-500">Haiku:</label>
          <select v-model="claudeSmallModel" :class="selectClass">
            <option v-for="m in claudeModelsSmall" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
      </div>

      <p class="text-[11px] text-gray-600 mb-2">Add to <code class="text-gray-500">~/.bashrc</code>, <code class="text-gray-500">~/.zshrc</code>, or equivalent</p>
      <Code :code="claudeSnippet" language="bash" />
    </div>

    <div>
      <div class="mb-3">
        <span class="text-sm font-semibold text-white">Codex</span>
      </div>

      <div class="flex min-w-0 items-center gap-2 mb-3">
        <label class="text-xs text-gray-500">Model:</label>
        <select v-model="codexModel" :class="selectClass">
          <option v-for="m in codexModelsList" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>

      <p class="text-[11px] text-gray-600 mb-2">Add to <code class="text-gray-500">~/.codex/config.toml</code></p>
      <Code :code="codexSnippet" language="toml" />

      <p class="text-[11px] text-gray-600 mt-4 mb-2">Add to <code class="text-gray-500">~/.bashrc</code>, <code class="text-gray-500">~/.zshrc</code>, or equivalent</p>
      <Code :code="codexEnvSnippet" language="bash" />
    </div>
  </div>
</template>
