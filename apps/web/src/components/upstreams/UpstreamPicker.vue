<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { providerMeta } from './provider-meta.ts';
import UpstreamBadge from './UpstreamBadge.vue';
import type { UpstreamColor, UpstreamProviderKind } from '../../api/types.ts';
import type { UpstreamOption } from '../../composables/useUpstreamOptions.ts';
import { Sortable, Switch } from '@floway-dev/ui';

export interface UpstreamPickerValue {
  override: boolean;
  ids: string[];
}

interface RowState {
  id: string;
  name: string;
  kind: UpstreamProviderKind;
  color: UpstreamColor | null;
  enabled: boolean;
}

const props = defineProps<{
  available: UpstreamOption[];
  title: string;
  inheritDescription: string;
}>();

const value = defineModel<UpstreamPickerValue>({ required: true });

const rows = ref<RowState[]>([]);

// Selected ids are resolved against the options rather than rendered on their
// own: the read path already drops ids whose upstream is gone, so anything
// left unresolved here is an option list that has not loaded yet.
const reset = () => {
  const optionById = new Map(props.available.map(option => [option.id, option]));
  const selected = value.value.ids.map(id => optionById.get(id)).filter(option => option !== undefined);
  const selectedIds = new Set(selected.map(option => option.id));
  const toRow = (option: UpstreamOption, enabled: boolean): RowState =>
    ({ id: option.id, name: option.name, kind: option.kind, color: option.color, enabled });
  rows.value = [
    ...selected.map(option => toRow(option, true)),
    ...props.available.filter(option => !selectedIds.has(option.id)).map(option => toRow(option, false)),
  ];
};

watch(() => [value.value, props.available] as const, reset, { immediate: true });

const setOverride = (next: boolean) => {
  value.value = { ...value.value, override: next };
};

const setRows = (next: RowState[]) => {
  rows.value = next;
  value.value = { ...value.value, ids: next.filter(r => r.enabled).map(r => r.id) };
};

const toggleRow = (id: string, enabled: boolean) => {
  setRows(rows.value.map(r => r.id === id ? { ...r, enabled } : r));
};

const badgeCount = computed(() => value.value.override ? rows.value.filter(r => r.enabled).length : props.available.length);
</script>

<template>
  <div class="space-y-3">
    <label class="flex items-center justify-between rounded-md border border-white/[0.06] bg-surface-800/40 px-3 py-2.5">
      <span>
        <p class="text-sm text-white">
          {{ title }}
          <span class="ml-1.5 font-mono text-[10px] font-medium text-accent-cyan">({{ badgeCount }})</span>
        </p>
        <p class="text-xs text-gray-500">{{ inheritDescription }}</p>
      </span>
      <Switch :model-value="value.override" @update:model-value="v => setOverride(!!v)" />
    </label>

    <Sortable
      v-if="value.override"
      :model-value="rows"
      @update:model-value="setRows"
      :item-key="(r: RowState) => r.id"
      handle=".floway-drag-handle"
      tag="ul"
      class="space-y-1.5"
    >
      <template #default="{ item: row }">
        <li :key="row.id" class="flex items-center gap-3 rounded-md border border-white/[0.06] bg-surface-800/40 px-3 py-2">
          <button
            type="button"
            class="floway-drag-handle grid size-6 cursor-grab place-items-center rounded text-gray-500 hover:bg-surface-700 hover:text-gray-200 active:cursor-grabbing"
            aria-label="Drag to reorder"
          >
            <i class="i-lucide-grip-vertical size-4" />
          </button>
          <Switch :model-value="row.enabled" @update:model-value="v => toggleRow(row.id, !!v)" />
          <UpstreamBadge
            :kind="row.kind"
            :color="row.color"
            variant="badge"
            size="sm"
            class="shrink-0 !rounded !uppercase tracking-wide"
          >{{ providerMeta(row.kind).label }}</UpstreamBadge>
          <span class="min-w-0 flex-1 truncate text-sm text-white">{{ row.name }}</span>
          <code class="text-xs text-gray-500">{{ row.id }}</code>
        </li>
      </template>
    </Sortable>
  </div>
</template>
