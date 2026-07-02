<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { computeModelWarnings, computeRuleWarnings, findCatalogModel } from './warnings.ts';
import type { ModelKind, AliasTarget, ChatAliasRules, ControlPlaneModel } from '../../api/types.ts';
import { Combobox, Select, Tooltip } from '@floway-dev/ui';

const target = defineModel<AliasTarget>({ required: true });

const props = defineProps<{
  kind: ModelKind;
  targetIdItems: readonly string[];
  models: readonly ControlPlaneModel[] | null;
  isFirst: boolean;
  isLast: boolean;
  isSole: boolean;
}>();

const emit = defineEmits<{
  moveUp: [];
  moveDown: [];
  remove: [];
}>();

const expanded = ref(false);
const canExpand = computed(() => props.kind === 'chat');
const toggleExpanded = () => { if (canExpand.value) expanded.value = !expanded.value; };

// Switching the alias kind on the parent collapses every non-chat row's
// body — there's no rule form to show, so an open chevron would be a
// dead state.
watch(() => props.kind, k => { if (k !== 'chat') expanded.value = false; });

const targetId = computed({
  get: () => target.value.target_model_id,
  set: v => { target.value = { ...target.value, target_model_id: v }; },
});

// Setters always clone the rules object so the v-model emit fires and the
// parent's targets array stays referentially up to date.
const setRules = (next: ChatAliasRules) => { target.value = { ...target.value, rules: next }; };

const patchReasoning = (patch: Partial<NonNullable<ChatAliasRules['reasoning']>>) => {
  const current = target.value.rules.reasoning ?? {};
  const next = { ...current, ...patch };
  for (const k of Object.keys(patch) as (keyof typeof patch)[]) {
    if (patch[k] === undefined) delete (next as Record<string, unknown>)[k];
  }
  if (Object.keys(next).length === 0) {
    const { reasoning: _, ...rest } = target.value.rules;
    setRules(rest);
  } else {
    setRules({ ...target.value.rules, reasoning: next });
  }
};

const setEffort = (raw: string) => patchReasoning({ effort: raw === '' ? undefined : raw });
const setSummary = (raw: string) => patchReasoning({ summary: raw === '' ? undefined : raw });

// Three-state adaptive control: `undefined` means "defer to the model";
// `true` forces reasoning on; `false` forces it off. A Switch can't
// represent the third state, so editing an existing record that had
// adaptive=false would silently round-trip to undefined.
type AdaptiveSelect = 'auto' | 'on' | 'off';
const ADAPTIVE_OPTIONS: { value: AdaptiveSelect; label: string }[] = [
  { value: 'auto', label: 'Auto (defer to model)' },
  { value: 'on', label: 'On (force adaptive)' },
  { value: 'off', label: 'Off (force non-adaptive)' },
];
const adaptiveSelect = computed<AdaptiveSelect>(() => {
  const v = target.value.rules.reasoning?.adaptive;
  if (v === true) return 'on';
  if (v === false) return 'off';
  return 'auto';
});
const setAdaptive = (raw: AdaptiveSelect | undefined) => {
  patchReasoning({ adaptive: raw === 'on' ? true : raw === 'off' ? false : undefined });
};
const setVerbosity = (raw: string) => {
  const next = { ...target.value.rules };
  if (raw === '') delete next.verbosity;
  else next.verbosity = raw;
  setRules(next);
};
const setServiceTier = (raw: string) => {
  const next = { ...target.value.rules };
  if (raw === '') delete next.serviceTier;
  else next.serviceTier = raw;
  setRules(next);
};

// String-bound view of the integer budget. Keeping the typed string in
// state means an in-progress "" or "1024foo" doesn't clobber the
// underlying numeric value mid-keystroke; the rules object only updates
// when the parsed number is a finite integer. The watch syncs the input
// back to the parent's value when the parent resets the rule object (e.g.
// the dialog switches `kind` and re-initialises every target row's rules).
const budgetText = ref(target.value.rules.reasoning?.budget_tokens === undefined ? '' : String(target.value.rules.reasoning.budget_tokens));
watch(() => target.value.rules.reasoning?.budget_tokens, parsed => {
  const next = parsed === undefined ? '' : String(parsed);
  if (next !== budgetText.value.trim()) budgetText.value = next;
});
const onBudgetChange = (raw: string) => {
  budgetText.value = raw;
  const trimmed = raw.trim();
  if (trimmed === '') {
    patchReasoning({ budget_tokens: undefined });
    return;
  }
  if (!/^\d+$/.test(trimmed)) return;
  patchReasoning({ budget_tokens: Number(trimmed) });
};

// Canonical presets pinned as type-ahead hints in the chat-rule comboboxes.
const EFFORT_ITEMS = ['none', 'low', 'medium', 'high', 'xhigh'];
const SUMMARY_ITEMS = ['auto', 'concise', 'detailed', 'none'];
const VERBOSITY_ITEMS = ['low', 'medium', 'high'];
const SERVICE_TIER_ITEMS = ['default', 'flex', 'priority', 'scale', 'fast'];

const catalog = computed(() => findCatalogModel(props.models, target.value.target_model_id));
const modelWarnings = computed(() => computeModelWarnings(target.value.target_model_id, catalog.value, props.kind));
const ruleWarnings = computed(() => computeRuleWarnings(target.value.rules, catalog.value));
const warningFor = (field: string) => ruleWarnings.value.find(w => w.field === field)?.message;
const modelWarningTooltip = computed(() => modelWarnings.value.join('\n'));
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-white/[0.06] bg-surface-800/40">
    <header class="flex items-center gap-2 px-3 py-2">
      <button
        type="button"
        class="grid size-6 shrink-0 place-items-center rounded text-gray-500 transition-colors hover:bg-white/5 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-500"
        :aria-expanded="expanded"
        :disabled="!canExpand"
        aria-label="Toggle target row"
        @click="toggleExpanded"
      >
        <svg
          class="size-4 transition-transform"
          :class="expanded && 'rotate-180'"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      <div class="min-w-0 flex-1">
        <Combobox
          v-model="targetId"
          :items="targetIdItems"
          placeholder="target model id"
          input-class="font-mono"
          borderless
          hide-dropdown-trigger
        />
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <Tooltip v-if="modelWarnings.length > 0" :content="modelWarningTooltip">
          <span class="inline-flex h-7 w-7 items-center justify-center rounded-md text-amber-400" aria-label="Model warning">
            <i class="i-lucide-alert-triangle size-4" />
          </span>
        </Tooltip>
        <button
          type="button"
          class="grid size-7 place-items-center rounded text-gray-500 transition-colors hover:bg-white/5 hover:text-gray-200 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-500"
          :disabled="isFirst"
          aria-label="Move target up"
          @click="emit('moveUp')"
        >
          <i class="i-lucide-arrow-up size-4" />
        </button>
        <button
          type="button"
          class="grid size-7 place-items-center rounded text-gray-500 transition-colors hover:bg-white/5 hover:text-gray-200 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-500"
          :disabled="isLast"
          aria-label="Move target down"
          @click="emit('moveDown')"
        >
          <i class="i-lucide-arrow-down size-4" />
        </button>
        <button
          type="button"
          class="grid size-7 place-items-center rounded text-gray-500 transition-colors hover:bg-white/5 hover:text-accent-rose disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-500"
          :disabled="isSole"
          aria-label="Remove target"
          @click="emit('remove')"
        >
          <i class="i-lucide-x size-4" />
        </button>
      </div>
    </header>

    <div v-if="expanded" class="border-t border-white/[0.06] p-3">
      <div v-if="kind === 'chat'" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Reasoning effort</label>
          <Combobox
            :model-value="target.rules.reasoning?.effort ?? ''"
            :items="EFFORT_ITEMS"
            placeholder="e.g. low"
            @update:model-value="setEffort"
          />
          <p v-if="warningFor('reasoning.effort')" class="mt-1 text-xs text-amber-300">{{ warningFor('reasoning.effort') }}</p>
        </div>

        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Reasoning budget tokens</label>
          <input
            type="text"
            inputmode="numeric"
            placeholder="e.g. 4096"
            class="h-9 w-full rounded-[10px] border border-white/[0.14] bg-surface-700 px-3 text-sm text-white placeholder:text-gray-600 focus:border-accent-cyan/50 focus:outline-none focus:ring-1 focus:ring-accent-cyan/30 font-mono"
            :value="budgetText"
            @input="(e: Event) => onBudgetChange((e.target as HTMLInputElement).value)"
          >
          <p v-if="warningFor('reasoning.budget_tokens')" class="mt-1 text-xs text-amber-300">{{ warningFor('reasoning.budget_tokens') }}</p>
        </div>

        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Adaptive reasoning</label>
          <Select
            :model-value="adaptiveSelect"
            :options="ADAPTIVE_OPTIONS"
            @update:model-value="setAdaptive"
          />
          <p v-if="warningFor('reasoning.adaptive')" class="mt-1 text-xs text-amber-300">{{ warningFor('reasoning.adaptive') }}</p>
        </div>

        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Reasoning summary</label>
          <Combobox
            :model-value="target.rules.reasoning?.summary ?? ''"
            :items="SUMMARY_ITEMS"
            placeholder="e.g. auto"
            @update:model-value="setSummary"
          />
          <p v-if="warningFor('reasoning.summary')" class="mt-1 text-xs text-amber-300">{{ warningFor('reasoning.summary') }}</p>
        </div>

        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Verbosity</label>
          <Combobox
            :model-value="target.rules.verbosity ?? ''"
            :items="VERBOSITY_ITEMS"
            placeholder="e.g. medium"
            @update:model-value="setVerbosity"
          />
          <p v-if="warningFor('verbosity')" class="mt-1 text-xs text-amber-300">{{ warningFor('verbosity') }}</p>
        </div>

        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Service tier</label>
          <Combobox
            :model-value="target.rules.serviceTier ?? ''"
            :items="SERVICE_TIER_ITEMS"
            placeholder="e.g. default"
            @update:model-value="setServiceTier"
          />
          <p v-if="warningFor('serviceTier')" class="mt-1 text-xs text-amber-300">{{ warningFor('serviceTier') }}</p>
        </div>
      </div>

      <p v-else class="text-xs text-gray-500">No per-target rules for this kind.</p>
    </div>
  </div>
</template>
