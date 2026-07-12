<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import EndpointsField from './EndpointsField.vue';
import FlagOverridesEditor from './FlagOverridesEditor.vue';
import { defaultEndpointsForKind, publicIdOf, titleFor, type Row } from './modelRows.ts';
import type { AnnouncedMetadata, BillingDimension, ModelKind, ModelPricing, UpstreamChatConfig, UpstreamModelConfig } from '../../api/types.ts';
import { parseOptionalNumber } from '../../utils/parse-optional-number.ts';
import ChatMetadataEditor from '../shared/ChatMetadataEditor.vue';
import { BILLING_DIMENSIONS, PRICING_AXES, canonicalPricingSelectorKey, type ModelPricing as ProtocolModelPricing, type PricingCoordinateValue, type PricingSelector, type PricingThresholdOperator, validateModelPricing } from '@floway-dev/protocols/common';
import type { Flag, FlagDefaults, FlagOverrides } from '@floway-dev/provider/flags';
import { Button, Input, Select, Switch } from '@floway-dev/ui';

const props = defineProps<{
  row: Row | null;
  flags: Flag[];
  upstreamFlagOverrides: FlagOverrides;
  providerFlagDefaults: FlagDefaults;
  // "Upstream Model ID" for custom/copilot, "Deployment" for azure.
  upstreamIdLabel: string;
  // True when this manual row's upstream id is fixed (seeded from an auto
  // twin) — the field renders read-only so the row keeps shadowing the twin.
  isUpstreamIdLocked: boolean;
  // Controls visibility of the "Switch to Auto / Manual" toggle in the header.
  hasAutoCounterpart: boolean;
  modeSwitchable: boolean;
}>();

const emit = defineEmits<{
  'patch-config': [patch: Partial<UpstreamModelConfig>];
  'set-mode': [next: 'auto' | 'manual'];
  remove: [];
  'validity-change': [valid: boolean];
}>();

const kindOptions: { value: ModelKind; label: string }[] = [
  { value: 'chat', label: 'Chat' },
  { value: 'embedding', label: 'Embedding' },
  { value: 'image', label: 'Image' },
];

const PRICING_LABELS: Record<BillingDimension, string> = {
  input: 'Input ($/MTok)',
  input_cache_read: 'Cache Read ($/MTok)',
  input_cache_write: 'Cache Write ($/MTok)',
  input_cache_write_1h: 'Cache Write (1h) ($/MTok)',
  input_image: 'Image Input ($/MTok)',
  output: 'Output ($/MTok)',
  output_image: 'Image Output ($/MTok)',
};

const PRICING_BY_KIND: Record<ModelKind, BillingDimension[]> = {
  chat: ['input', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h', 'output'],
  embedding: ['input'],
  image: ['input', 'input_image', 'output', 'output_image'],
};

const config = computed<UpstreamModelConfig | null>(() => props.row?.config ?? null);
const editable = computed(() => props.row?.kind === 'manual');
const rowKind = computed<ModelKind>(() => config.value?.kind ?? 'chat');

const patch = (next: Partial<UpstreamModelConfig>) => {
  if (!editable.value) return;
  emit('patch-config', next);
};

const setKind = (k: ModelKind) => {
  if (!editable.value || !config.value) return;
  patch({ kind: k, endpoints: defaultEndpointsForKind(k, config.value.endpoints) });
};

interface PricingThresholdDraft {
  operator: PricingThresholdOperator;
  value?: number;
}

interface PricingEntryDraft {
  id: number;
  selector: Record<string, string | PricingThresholdDraft | undefined>;
  rates: Partial<Record<BillingDimension, number>>;
}

let pricingEntryDraftIdSeq = 0;

const pricingEntryDraftsFor = (cost: ModelPricing | undefined): PricingEntryDraft[] =>
  (cost?.entries ?? []).map(entry => ({
    id: ++pricingEntryDraftIdSeq,
    selector: { ...(entry.selector ?? {}) },
    rates: { ...entry.rates },
  }));

const pricingEntryDrafts = ref<PricingEntryDraft[]>(pricingEntryDraftsFor(config.value?.cost));
const selectedPricingEntryId = ref<number | null>(pricingEntryDrafts.value[0]?.id ?? null);
const lastFlagOverrides = ref<FlagOverrides>({});

watch(() => [props.row?.uiId, props.row?.kind] as const, () => {
  pricingEntryDrafts.value = pricingEntryDraftsFor(config.value?.cost);
  selectedPricingEntryId.value = pricingEntryDrafts.value[0]?.id ?? null;
  lastFlagOverrides.value = {};
});

const selectedPricingEntryIndex = computed(() => pricingEntryDrafts.value.findIndex(draft => draft.id === selectedPricingEntryId.value));
const selectedPricingEntry = computed(() => pricingEntryDrafts.value[selectedPricingEntryIndex.value] ?? null);

const compactSelector = (draft: PricingEntryDraft): PricingSelector => {
  const selector: Record<string, PricingCoordinateValue> = {};
  for (const [axisId, coordinate] of Object.entries(draft.selector)) {
    if (typeof coordinate === 'string') selector[axisId] = coordinate;
    else if (coordinate?.value !== undefined) selector[axisId] = { operator: coordinate.operator, value: coordinate.value };
  }
  return selector;
};

const coordinateKey = (draft: PricingEntryDraft): string | null => {
  try {
    return canonicalPricingSelectorKey(compactSelector(draft));
  } catch {
    return null;
  }
};

const duplicatePricingCoordinates = computed(() => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const draft of pricingEntryDrafts.value) {
    const key = coordinateKey(draft);
    if (key === null) continue;
    if (seen.has(key)) duplicates.add(key);
    else seen.add(key);
  }
  return duplicates;
});

const hasRates = (draft: PricingEntryDraft): boolean => BILLING_DIMENSIONS.some(dimension => draft.rates[dimension] !== undefined);
const rateDimensionKey = (draft: PricingEntryDraft): string =>
  BILLING_DIMENSIONS.filter(dimension => draft.rates[dimension] !== undefined).join('\0');
const hasValidSelector = (draft: PricingEntryDraft): boolean => {
  try {
    canonicalPricingSelectorKey(compactSelector(draft));
    return true;
  } catch {
    return false;
  }
};

const pricingValidationError = computed<string | null>(() => {
  const invalidDraft = pricingEntryDrafts.value.find(draft => !hasRates(draft) || !hasValidSelector(draft));
  if (invalidDraft) return !hasRates(invalidDraft) ? 'Set at least one rate.' : 'Selector values are invalid.';
  if (duplicatePricingCoordinates.value.size > 0) return 'Duplicate selector coordinate.';
  if (pricingEntryDrafts.value.length === 0) return null;
  if (new Set(pricingEntryDrafts.value.map(rateDimensionKey)).size > 1) return 'All pricing entries must set the same rate fields.';
  try {
    validateModelPricing({
      entries: pricingEntryDrafts.value.map(draft => ({ selector: compactSelector(draft), rates: draft.rates })),
    } as ProtocolModelPricing);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
});

const isPricingValid = computed(() => pricingValidationError.value === null);

const writePricingEntries = (drafts: readonly PricingEntryDraft[]) => {
  if (!config.value) return;
  pricingEntryDrafts.value = drafts.map(draft => ({ ...draft, selector: { ...draft.selector }, rates: { ...draft.rates } }));
  if (drafts.length === 0) {
    patch({ cost: undefined });
    return;
  }
  const entries = drafts.map(draft => {
    const selector = compactSelector(draft);
    return { ...(Object.keys(selector).length > 0 ? { selector } : {}), rates: { ...draft.rates } };
  });
  patch({ cost: { entries } });
};

const updateEqualityCoordinate = (index: number, axisId: string, raw: string | number | null | undefined) => {
  const value = String(raw ?? '').trim();
  writePricingEntries(pricingEntryDrafts.value.map((draft, i) => i === index
    ? { ...draft, selector: { ...draft.selector, [axisId]: value || undefined } }
    : draft));
};

const thresholdCoordinate = (draft: PricingEntryDraft, axisId: string): PricingThresholdDraft | undefined => {
  const value = draft.selector[axisId];
  return value && typeof value === 'object' ? value : undefined;
};

const updateThresholdCoordinate = (index: number, axisId: string, patch: Partial<PricingThresholdDraft>) => {
  writePricingEntries(pricingEntryDrafts.value.map((draft, i) => {
    if (i !== index) return draft;
    const current = thresholdCoordinate(draft, axisId);
    const operator = patch.operator ?? current?.operator ?? 'gt';
    const value = 'value' in patch ? patch.value : current?.value;
    return { ...draft, selector: { ...draft.selector, [axisId]: { operator, ...(value !== undefined ? { value } : {}) } } };
  }));
};

const toggleThresholdOperator = (index: number, axisId: string) => {
  const draft = pricingEntryDrafts.value[index];
  if (!draft) return;
  const operator = thresholdCoordinate(draft, axisId)?.operator === 'gte' ? 'gt' : 'gte';
  updateThresholdCoordinate(index, axisId, { operator });
};

const updatePricingRate = (index: number, dimension: BillingDimension, raw: string | number | null | undefined) => {
  const value = parseOptionalNumber(raw);
  const next = pricingEntryDrafts.value.map((draft, i) => {
    if (i !== index) return draft;
    const rates = { ...draft.rates };
    if (value === undefined) delete rates[dimension];
    else rates[dimension] = value;
    return { ...draft, rates };
  });
  writePricingEntries(next);
};

const pricingEntryCoordinateLabel = (draft: PricingEntryDraft): string => {
  const labels = PRICING_AXES.flatMap(axis => {
    const coordinate = draft.selector[axis.id];
    if (axis.kind === 'equality') return typeof coordinate === 'string' && coordinate !== '' ? [coordinate] : [];
    if (!coordinate || typeof coordinate !== 'object') return [];
    if (coordinate.value === undefined) return [];
    return [`${coordinate.operator === 'gte' ? '>=' : '>'} ${coordinate.value} tokens`];
  });
  return labels.length > 0 ? labels.join(' · ') : 'Base';
};

const addPricingEntry = () => {
  const draft: PricingEntryDraft = { id: ++pricingEntryDraftIdSeq, selector: {}, rates: {} };
  selectedPricingEntryId.value = draft.id;
  writePricingEntries([...pricingEntryDrafts.value, draft]);
};
const removePricingEntry = (index: number) => {
  const removed = pricingEntryDrafts.value[index];
  const next = pricingEntryDrafts.value.filter((_, i) => i !== index);
  if (removed?.id === selectedPricingEntryId.value) {
    selectedPricingEntryId.value = next[index]?.id ?? next[index - 1]?.id ?? null;
  }
  writePricingEntries(next);
};
const movePricingEntry = (index: number, offset: -1 | 1) => {
  const target = index + offset;
  if (target < 0 || target >= pricingEntryDrafts.value.length) return;
  const next = [...pricingEntryDrafts.value];
  [next[index], next[target]] = [next[target]!, next[index]!];
  writePricingEntries(next);
};

const toggleFlagOverridesEnabled = () => {
  if (!editable.value || !config.value) return;
  if (config.value.flagOverrides !== undefined) {
    lastFlagOverrides.value = { ...config.value.flagOverrides };
    patch({ flagOverrides: undefined });
  } else {
    patch({ flagOverrides: { ...lastFlagOverrides.value } });
  }
};

// ── Chat metadata ──────────────────────────────────────────────────────────

// Mirror the shared editor's value shape: pull the model's `limits` +
// `chat` block out of the row config, hand it to ChatMetadataEditor,
// and forward edits back through `patch()`.
const chatMetadataValue = computed<AnnouncedMetadata | undefined>(() => {
  if (!config.value) return undefined;
  const out: AnnouncedMetadata = {};
  if (config.value.limits) out.limits = config.value.limits;
  if (config.value.chat) out.chat = config.value.chat;
  return out;
});

const onChatMetadataChange = (next: AnnouncedMetadata | undefined) => {
  // The editor builds `chat` through fresh object literals — its
  // `readonly` modality arrays are nominally typed, never frozen, so the
  // mutable `UpstreamChatConfig` shape held in `config` accepts them.
  patch({ limits: next?.limits, chat: next?.chat as UpstreamChatConfig | undefined });
};

// A chat row is invalid when:
// - effort is enabled but supported list is empty
// - effort is enabled but default is empty or not in supported
// - budget_tokens is enabled but max < min (when both are set)
const isReasoningValid = computed<boolean>(() => {
  const reasoning = config.value?.chat?.reasoning;
  if (reasoning === undefined) return true;

  if (reasoning.effort !== undefined) {
    const effort = reasoning.effort;
    if (effort.supported.length === 0) return false;
    if (effort.default === '' || !effort.supported.includes(effort.default)) return false;
  }

  if (reasoning.budget_tokens !== undefined) {
    const bt = reasoning.budget_tokens;
    if (bt.min !== undefined && bt.max !== undefined && bt.max < bt.min) return false;
  }

  return true;
});

const isValid = computed(() => isReasoningValid.value && isPricingValid.value);
watch(isValid, valid => { emit('validity-change', valid); }, { immediate: true });
</script>

<template>
  <div class="flex min-h-[28rem] flex-col">
    <div v-if="!row || !config" class="flex flex-1 items-center justify-center p-12 text-center text-sm text-gray-500">
      Select a model on the left to edit its settings.
    </div>

    <template v-else>
      <header class="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-5 py-4">
        <div class="min-w-0">
          <h2 class="truncate text-lg font-semibold text-white">{{ titleFor(row) }}</h2>
          <p class="mt-1 flex items-center gap-2 font-mono text-xs text-gray-500">
            <span class="truncate">{{ publicIdOf(row) || '—' }}</span>
            <span v-if="!editable" class="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-gray-400">Auto</span>
            <span v-else class="rounded border border-accent-cyan/30 bg-accent-cyan/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent-cyan">Manual</span>
          </p>
        </div>
        <div class="ml-auto flex shrink-0 items-center gap-2">
          <Button
            v-if="modeSwitchable && hasAutoCounterpart && !editable"
            variant="secondary"
            size="sm"
            @click="$emit('set-mode', 'manual')"
          >Switch to Manual</Button>
          <Button
            v-else-if="modeSwitchable && hasAutoCounterpart && editable"
            variant="secondary"
            size="sm"
            @click="$emit('set-mode', 'auto')"
          >Switch to Auto</Button>
          <Button
            v-if="editable"
            variant="danger"
            size="sm"
            @click="$emit('remove')"
          >Remove</Button>
        </div>
      </header>

      <div class="space-y-7 px-5 py-6">

        <section>
          <div class="mb-3 flex items-baseline gap-3">
            <h3 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Identity</h3>
            <span class="text-[11px] text-gray-500">how the model is exposed publicly and what we send upstream</span>
          </div>
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <label class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">Display Name</span>
              <Input
                :model-value="config.display_name"
                :readonly="!editable"
                placeholder="e.g. GPT 5.4 Pro"
                @update:model-value="v => patch({ display_name: v || undefined })"
              />
            </label>
            <label class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">{{ upstreamIdLabel }}</span>
              <Input
                :model-value="config.upstreamModelId"
                :readonly="!editable || isUpstreamIdLocked"
                placeholder="raw upstream id"
                class="font-mono"
                @update:model-value="v => patch({ upstreamModelId: v })"
              />
            </label>
            <label class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">Public Model ID</span>
              <Input
                :model-value="config.publicModelId"
                :readonly="!editable"
                :placeholder="config.upstreamModelId || ''"
                class="font-mono"
                @update:model-value="v => patch({ publicModelId: v || undefined })"
              />
            </label>
            <label class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">Kind</span>
              <Select
                v-if="editable"
                :model-value="rowKind"
                :options="kindOptions"
                @update:model-value="k => setKind(k as ModelKind)"
              />
              <div v-else tabindex="-1" style="pointer-events: none">
                <Select :model-value="rowKind" :options="kindOptions" />
              </div>
            </label>
          </div>
        </section>

        <section v-if="rowKind !== 'embedding'">
          <div class="mb-3 flex items-baseline gap-3">
            <h3 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Supported Endpoints</h3>
            <span class="text-[11px] text-gray-500">protocols this model responds to</span>
          </div>
          <EndpointsField
            :model-value="config.endpoints ?? {}"
            :kind="rowKind === 'image' ? 'image' : 'chat'"
            :disabled="!editable"
            @update:model-value="v => patch({ endpoints: v })"
          />
        </section>

        <ChatMetadataEditor
          v-if="rowKind !== 'image'"
          :model-value="chatMetadataValue"
          :kind="rowKind"
          :mode="editable ? 'manual' : 'auto'"
          @update:model-value="onChatMetadataChange"
        />

        <section>
          <div class="mb-3">
            <h3 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Pricing Entries</h3>
          </div>
          <p v-if="pricingValidationError" class="mb-3 text-[11px] text-accent-rose">{{ pricingValidationError }}</p>
          <div class="overflow-hidden rounded-lg border border-white/[0.06]">
            <div class="grid md:grid-cols-[13rem_minmax(0,1fr)]">
              <aside class="flex min-w-0 flex-col border-b border-white/[0.06] bg-surface-800/25 md:border-b-0 md:border-r" aria-label="Pricing entry navigation">
                <ul v-if="pricingEntryDrafts.length > 0" class="divide-y divide-white/[0.04]" aria-label="Pricing entries">
                  <li
                    v-for="(draft, index) in pricingEntryDrafts"
                    :key="draft.id"
                    class="flex min-w-0 items-center transition-colors"
                    :class="selectedPricingEntryId === draft.id ? 'bg-accent-cyan/[0.06]' : 'hover:bg-white/[0.025]'"
                  >
                    <button
                      type="button"
                      class="min-w-0 flex-1 px-3 py-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-cyan/60"
                      :aria-label="`Edit pricing entry ${index + 1}: ${pricingEntryCoordinateLabel(draft)}`"
                      :aria-current="selectedPricingEntryId === draft.id ? 'true' : undefined"
                      :title="pricingEntryCoordinateLabel(draft)"
                      @click="selectedPricingEntryId = draft.id"
                    >
                      <span class="block truncate font-mono text-[11px]" :class="selectedPricingEntryId === draft.id ? 'text-accent-cyan' : 'text-gray-300'">{{ pricingEntryCoordinateLabel(draft) }}</span>
                    </button>
                    <div v-if="editable" class="mr-1 flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        class="grid size-6 place-items-center rounded text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan disabled:pointer-events-none disabled:opacity-30"
                        :disabled="index === 0"
                        :aria-label="`Move pricing entry ${index + 1} up`"
                        @click="movePricingEntry(index, -1)"
                      >
                        <i class="i-lucide-arrow-up size-3" />
                      </button>
                      <button
                        type="button"
                        class="grid size-6 place-items-center rounded text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan disabled:pointer-events-none disabled:opacity-30"
                        :disabled="index === pricingEntryDrafts.length - 1"
                        :aria-label="`Move pricing entry ${index + 1} down`"
                        @click="movePricingEntry(index, 1)"
                      >
                        <i class="i-lucide-arrow-down size-3" />
                      </button>
                      <button
                        type="button"
                        class="grid size-6 place-items-center rounded text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-rose"
                        :aria-label="`Remove pricing entry ${index + 1}`"
                        @click="removePricingEntry(index)"
                      >
                        <i class="i-lucide-x size-3" />
                      </button>
                    </div>
                  </li>
                </ul>
                <p v-else class="px-3 py-4 text-[11px] text-gray-600">No pricing entries configured.</p>
                <div v-if="editable" class="mt-auto border-t border-white/[0.06] p-2">
                  <Button variant="secondary" size="sm" class="w-full" @click="addPricingEntry">
                    <i class="i-lucide-plus size-3.5" />
                    Add Entry
                  </Button>
                </div>
              </aside>

              <div v-if="selectedPricingEntry && selectedPricingEntryIndex >= 0" class="min-w-0 p-4">
                <div class="mb-4 grid gap-3 sm:grid-cols-2">
                  <label v-for="axis in PRICING_AXES" :key="axis.id" class="block space-y-1.5">
                    <span class="block text-xs font-medium text-gray-500">{{ axis.label }}</span>
                    <Input
                      v-if="axis.kind === 'equality'"
                      :model-value="typeof selectedPricingEntry.selector[axis.id] === 'string' ? selectedPricingEntry.selector[axis.id] as string : ''"
                      :readonly="!editable"
                      :invalid="!hasValidSelector(selectedPricingEntry) || coordinateKey(selectedPricingEntry) !== null && duplicatePricingCoordinates.has(coordinateKey(selectedPricingEntry)!)"
                      placeholder="default"
                      class="font-mono"
                      @update:model-value="v => updateEqualityCoordinate(selectedPricingEntryIndex, axis.id, v)"
                    />
                    <div v-else class="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-2">
                      <button
                        type="button"
                        class="inline-flex h-9 items-center justify-center rounded-[10px] border border-white/[0.08] bg-surface-700 font-mono text-xs text-gray-300 transition-colors hover:border-white/[0.15] hover:bg-white/[0.08] disabled:cursor-default disabled:opacity-60 disabled:hover:border-white/[0.08] disabled:hover:bg-surface-700"
                        :disabled="!editable"
                        :aria-label="`${axis.label} operator ${thresholdCoordinate(selectedPricingEntry, axis.id)?.operator === 'gte' ? '>=' : '>'}; click to toggle`"
                        @click="toggleThresholdOperator(selectedPricingEntryIndex, axis.id)"
                      >{{ thresholdCoordinate(selectedPricingEntry, axis.id)?.operator === 'gte' ? '>=' : '>' }}</button>
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        :model-value="thresholdCoordinate(selectedPricingEntry, axis.id)?.value"
                        :readonly="!editable"
                        :invalid="!hasValidSelector(selectedPricingEntry) || coordinateKey(selectedPricingEntry) !== null && duplicatePricingCoordinates.has(coordinateKey(selectedPricingEntry)!)"
                        placeholder="base"
                        class="font-mono"
                        @update:model-value="v => updateThresholdCoordinate(selectedPricingEntryIndex, axis.id, { value: parseOptionalNumber(v) })"
                      />
                    </div>
                  </label>
                </div>
                <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <label v-for="dim in PRICING_BY_KIND[rowKind]" :key="dim" class="block space-y-1.5">
                    <span class="block text-xs font-medium text-gray-500">{{ PRICING_LABELS[dim] }}</span>
                    <Input
                      type="number"
                      min="0"
                      :model-value="selectedPricingEntry.rates[dim]"
                      :readonly="!editable"
                      placeholder="unpriced"
                      class="font-mono"
                      @update:model-value="v => updatePricingRate(selectedPricingEntryIndex, dim, v)"
                    />
                  </label>
                </div>
              </div>
              <div v-else class="flex min-h-52 items-center justify-center p-6 text-center text-[11px] text-gray-600">
                Add a pricing entry to edit its selector and rates.
              </div>
            </div>
          </div>
        </section>

        <section>
          <div class="mb-3 flex items-baseline gap-3">
            <h3 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Feature Flags</h3>
            <span v-if="editable" class="text-[11px] text-gray-500">applied on top of upstream-level flags; <code class="font-mono">Inherit</code> reflects the upstream-resolved value</span>
            <Switch
              v-if="editable"
              :model-value="config.flagOverrides !== undefined"
              class="ml-auto"
              @update:model-value="toggleFlagOverridesEnabled"
            />
          </div>
          <FlagOverridesEditor
            v-if="!editable || config.flagOverrides !== undefined"
            :model-value="config.flagOverrides ?? {}"
            :flags="flags"
            :provider-defaults="providerFlagDefaults"
            :inherited-overrides="upstreamFlagOverrides"
            :name-prefix="`${row.uiId}-flag`"
            :read-only="!editable"
            class="max-h-72"
            @update:model-value="v => patch({ flagOverrides: v })"
          />
          <p v-else class="text-[11px] text-gray-600">
            Toggle on to override individual flags for this model only.
          </p>
        </section>

      </div>
    </template>
  </div>
</template>
