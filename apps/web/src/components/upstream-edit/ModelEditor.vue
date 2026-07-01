<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import EndpointsField from './EndpointsField.vue';
import FlagOverridesEditor from './FlagOverridesEditor.vue';
import { configOf, defaultEndpointsForKind, publicIdOf, titleFor, type Row } from './modelRows.ts';
import type { AnnouncedMetadata, BillingDimension, FlagDef, ModelKind, ModelPricing, UpstreamChatConfig, UpstreamModelConfig, UpstreamProviderKind } from '../../api/types.ts';
import { parseOptionalNumber } from '../../utils/parse-optional-number.ts';
import ChatMetadataEditor from '../shared/ChatMetadataEditor.vue';
import { Button, Input, Select, Switch, Tooltip } from '@floway-dev/ui';

const props = defineProps<{
  row: Row | null;
  flags: FlagDef[];
  upstreamFlagOverrides: Record<string, boolean>;
  flagProviderKind: UpstreamProviderKind;
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

const config = computed<UpstreamModelConfig | null>(() => props.row ? configOf(props.row) : null);
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

const updateCost = (key: BillingDimension, raw: string | number | null | undefined) => {
  if (!config.value) return;
  const cost = { ...(config.value.cost ?? {}) } as ModelPricing;
  const num = parseOptionalNumber(raw);
  if (num === undefined) delete cost[key];
  else cost[key] = num;
  // Every dimension is independently optional. The row stores `cost: undefined`
  // rather than an empty stub when every base dimension AND the tiers overlay
  // are empty. A bare check on `Object.values(cost)` would keep the row alive
  // forever once any tier was added, because `cost.tiers` is a populated object
  // even when every base rate is cleared.
  const { tiers, ...base } = cost;
  const hasBase = Object.values(base).some(v => v !== undefined);
  const hasTiers = tiers !== undefined && Object.keys(tiers).length > 0;
  patch({ cost: hasBase || hasTiers ? cost : undefined });
};

// Per-tier overlays. A tier overlay is a sparse pricing snapshot keyed by
// dimension; declared fields shadow the base rate, absent fields fall
// through. We hold drafts in local state (rather than recomputing from the
// stored cost on every keystroke) so an in-progress tier whose name is still
// empty stays on screen — `writeTierDrafts` skips empty-name entries, so a
// purely-derived list would lose newly-added rows. Each draft also carries
// a stable `id` separate from its name so removing a middle row doesn't
// re-key its neighbors mid-edit (Vue would otherwise reuse one input's DOM
// for another row's value).
interface TierDraft { id: number; name: string; rates: Partial<Record<BillingDimension, number>> }

let tierDraftIdSeq = 0;

const hasFiniteRate = (rates: TierDraft['rates']): boolean =>
  Object.values(rates).some(v => typeof v === 'number' && Number.isFinite(v));

const tierDraftsFor = (cost: ModelPricing | undefined): TierDraft[] => {
  const tiers = cost?.tiers;
  if (!tiers) return [];
  return Object.entries(tiers).map(([name, rates]) => ({ id: ++tierDraftIdSeq, name, rates: { ...rates } }));
};

const tierDrafts = ref<TierDraft[]>(tierDraftsFor(config.value?.cost));

// Per-tier overrides are a niche editing surface — most operators stay on the
// base pricing for the model's lifetime. Default the section collapsed on a
// row with no overrides so the page reads as a base-pricing form; on a row
// that already has overrides, default expanded so the operator sees them
// without an extra click. An Add Tier click also auto-expands.
const tierSectionExpanded = ref(tierDrafts.value.length > 0);

// Resync the local drafts whenever the active row changes (a different model's
// cost replaces the working set). Edits within the same row leave the drafts
// alone — `writeTierDrafts` writes both local state and stored cost in lockstep.
watch(() => props.row?.uiId, () => {
  tierDrafts.value = tierDraftsFor(config.value?.cost);
  tierSectionExpanded.value = tierDrafts.value.length > 0;
});

const writeTierDrafts = (drafts: readonly TierDraft[]) => {
  if (!config.value) return;
  tierDrafts.value = drafts.map(d => ({ id: d.id, name: d.name, rates: { ...d.rates } }));
  const base = { ...(config.value.cost ?? {}) } as ModelPricing;
  delete base.tiers;
  const tiers: Record<string, Partial<Record<BillingDimension, number>>> = {};
  for (const draft of drafts) {
    const trimmed = draft.name.trim();
    if (!trimmed) continue;
    // Last write wins on duplicate names — the validation message in the
    // template tells the operator to rename collisions.
    const rates: Partial<Record<BillingDimension, number>> = {};
    for (const [k, v] of Object.entries(draft.rates)) {
      if (typeof v === 'number' && Number.isFinite(v)) rates[k as BillingDimension] = v;
    }
    if (Object.keys(rates).length > 0) tiers[trimmed] = rates;
  }
  const next: ModelPricing = { ...base };
  if (Object.keys(tiers).length > 0) next.tiers = tiers;
  patch({ cost: Object.keys(next).length > 0 ? next : undefined });
};

const duplicateTierNames = computed<Set<string>>(() => {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const draft of tierDrafts.value) {
    const name = draft.name.trim();
    if (!name) continue;
    if (seen.has(name)) dupes.add(name);
    else seen.add(name);
  }
  return dupes;
});

// Same predicate `writeTierDrafts` uses to decide whether a draft survives
// into the persisted shape. The badge and any "this row will not save" hint
// both key off this so what the dashboard surfaces matches what gets written.
const isTierDraftPersistable = (draft: TierDraft): boolean =>
  draft.name.trim() !== '' && hasFiniteRate(draft.rates);

const effectiveTierCount = computed(() => {
  const names = new Set<string>();
  for (const draft of tierDrafts.value) {
    if (isTierDraftPersistable(draft)) names.add(draft.name.trim());
  }
  return names.size;
});

const draftHasOrphanRates = (draft: TierDraft): boolean =>
  draft.name.trim() === '' && hasFiniteRate(draft.rates);

// Inverse of orphan-rates: name supplied but every rate left blank. Such a
// row is silently dropped on save because `isTierDraftPersistable` requires
// at least one finite rate. Surface the same inline warning so the operator
// is not surprised when their tier "disappears" after reload.
const draftHasOnlyName = (draft: TierDraft): boolean =>
  draft.name.trim() !== '' && !hasFiniteRate(draft.rates);

const updateTierName = (index: number, name: string) => {
  const next = tierDrafts.value.map((draft, i) => i === index ? { ...draft, name } : draft);
  writeTierDrafts(next);
};

const updateTierRate = (index: number, dim: BillingDimension, raw: string | number | null | undefined) => {
  const num = parseOptionalNumber(raw);
  const next = tierDrafts.value.map((draft, i) => {
    if (i !== index) return draft;
    const rates = { ...draft.rates };
    if (num === undefined) delete rates[dim];
    else rates[dim] = num;
    return { ...draft, rates };
  });
  writeTierDrafts(next);
};

const addTier = () => {
  writeTierDrafts([...tierDrafts.value, { id: ++tierDraftIdSeq, name: '', rates: {} }]);
  tierSectionExpanded.value = true;
};

const removeTier = (index: number) => {
  writeTierDrafts(tierDrafts.value.filter((_, i) => i !== index));
};

const moveTierUp = (index: number) => {
  if (index <= 0) return;
  const next = [...tierDrafts.value];
  [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
  writeTierDrafts(next);
};

const moveTierDown = (index: number) => {
  if (index >= tierDrafts.value.length - 1) return;
  const next = [...tierDrafts.value];
  [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
  writeTierDrafts(next);
};

const toggleFlagOverridesEnabled = () => {
  if (!editable.value || !config.value) return;
  if (config.value.flagOverrides?.enabled) {
    patch({ flagOverrides: undefined });
  } else {
    patch({ flagOverrides: { enabled: true, values: { ...(config.value.flagOverrides?.values ?? {}) } } });
  }
};

const updateFlagOverrides = (values: Record<string, boolean>) => {
  patch({ flagOverrides: { enabled: true, values } });
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

watch(isReasoningValid, valid => { emit('validity-change', valid); }, { immediate: true });
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
          <div class="mb-3 flex items-baseline gap-3">
            <h3 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Pricing</h3>
            <span class="text-[11px] text-gray-500">$ per million tokens — used for usage attribution</span>
          </div>
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <label v-for="dim in PRICING_BY_KIND[rowKind]" :key="dim" class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">{{ PRICING_LABELS[dim] }}</span>
              <Input
                type="number"
                min="0"
                :model-value="config.cost?.[dim]"
                :readonly="!editable"
                placeholder="$/MTok"
                class="font-mono"
                @update:model-value="v => updateCost(dim, v)"
              />
            </label>
          </div>
        </section>

        <section>
          <div class="mb-3 flex items-baseline gap-3">
            <button
              type="button"
              class="flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-300 transition-colors"
              :aria-expanded="tierSectionExpanded"
              aria-controls="tier-overrides-panel"
              @click="tierSectionExpanded = !tierSectionExpanded"
            >
              <i :class="tierSectionExpanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-3 self-center" />
              <span>Per-Tier Pricing Overrides</span>
              <span
                v-if="effectiveTierCount > 0"
                class="text-accent-cyan"
                :aria-label="`${effectiveTierCount} tier override${effectiveTierCount === 1 ? '' : 's'} configured`"
              >({{ effectiveTierCount }})</span>
            </button>
            <Button
              v-if="editable"
              variant="secondary"
              size="sm"
              class="ml-auto"
              @click="addTier"
            >+ Add Tier</Button>
          </div>
          <div id="tier-overrides-panel" v-show="tierSectionExpanded">
            <div v-if="tierDrafts.length === 0" class="text-[11px] text-gray-600">
              <template v-if="editable">No tiers defined. Add one to override pricing for requests stamped with a service tier.</template>
              <template v-else>No tier overrides on this model.</template>
            </div>
            <div v-else class="space-y-6">
              <div
                v-for="(draft, index) in tierDrafts"
                :key="draft.id"
              >
                <div class="mb-3 flex items-center gap-3">
                  <span class="shrink-0 text-xs font-medium text-gray-500">Tier</span>
                  <Input
                    :model-value="draft.name"
                    :readonly="!editable"
                    :invalid="duplicateTierNames.has(draft.name.trim()) || draftHasOrphanRates(draft) || draftHasOnlyName(draft)"
                    placeholder="e.g. fast"
                    class="max-w-xs font-mono"
                    @update:model-value="v => updateTierName(index, v)"
                  />
                  <div v-if="editable" class="ml-auto flex items-center gap-1">
                    <Tooltip content="Move up">
                      <button
                        type="button"
                        class="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan disabled:pointer-events-none disabled:opacity-30"
                        :disabled="index === 0"
                        aria-label="Move tier up"
                        @click="moveTierUp(index)"
                      >
                        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="m18 15-6-6-6 6" />
                        </svg>
                      </button>
                    </Tooltip>
                    <Tooltip content="Move down">
                      <button
                        type="button"
                        class="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan disabled:pointer-events-none disabled:opacity-30"
                        :disabled="index === tierDrafts.length - 1"
                        aria-label="Move tier down"
                        @click="moveTierDown(index)"
                      >
                        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </button>
                    </Tooltip>
                    <Tooltip content="Remove">
                      <button
                        type="button"
                        class="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-rose"
                        aria-label="Remove tier"
                        @click="removeTier(index)"
                      >
                        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M18 6 6 18" />
                          <path d="m6 6 12 12" />
                        </svg>
                      </button>
                    </Tooltip>
                  </div>
                </div>
                <p v-if="duplicateTierNames.has(draft.name.trim())" class="mb-2 text-[11px] text-accent-rose">
                  Duplicate tier name — only the last entry with this name is saved.
                </p>
                <p v-else-if="draftHasOrphanRates(draft)" class="mb-2 text-[11px] text-accent-rose">
                  Tier name required — this row's rates will not save.
                </p>
                <p v-else-if="draftHasOnlyName(draft)" class="mb-2 text-[11px] text-accent-rose">
                  Set at least one rate — this row will not save.
                </p>
                <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <label v-for="dim in PRICING_BY_KIND[rowKind]" :key="dim" class="block space-y-1.5">
                    <span class="block text-xs font-medium text-gray-500">{{ PRICING_LABELS[dim] }}</span>
                    <Input
                      type="number"
                      min="0"
                      :model-value="draft.rates[dim]"
                      :readonly="!editable"
                      placeholder="inherit"
                      class="font-mono"
                      @update:model-value="v => updateTierRate(index, dim, v)"
                    />
                  </label>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section>
          <div class="mb-3 flex items-baseline gap-3">
            <h3 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Override Feature Flags</h3>
            <span class="text-[11px] text-gray-500">applied on top of upstream-level flags; <code class="font-mono">Inherit</code> reflects the upstream-resolved value</span>
            <Switch
              v-if="editable"
              :model-value="config.flagOverrides?.enabled === true"
              class="ml-auto"
              @update:model-value="toggleFlagOverridesEnabled"
            />
            <Switch v-else :model-value="false" disabled class="ml-auto" />
          </div>
          <FlagOverridesEditor
            v-if="editable && config.flagOverrides?.enabled"
            :model-value="config.flagOverrides?.values ?? {}"
            :flags="flags"
            :kind="flagProviderKind"
            :inherited-overrides="upstreamFlagOverrides"
            :name-prefix="`${row.uiId}-flag`"
            class="max-h-72"
            @update:model-value="updateFlagOverrides"
          />
          <p v-else-if="editable" class="text-[11px] text-gray-600">
            Toggle on to override individual flags for this model only.
          </p>
          <p v-else class="text-[11px] text-gray-600">
            Auto models inherit upstream flags. Switch to Manual to override per model.
          </p>
        </section>

      </div>
    </template>
  </div>
</template>
