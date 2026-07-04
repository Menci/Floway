<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { UpstreamProviderKind } from '../../api/types.ts';
import type { UpstreamOption } from '../../composables/useUpstreamOptions.ts';
import { assertNever } from '../../utils/assert-never.ts';
import { Badge, Sortable, Switch } from '@floway-dev/ui';

export interface UpstreamPickerValue {
  override: boolean;
  ids: string[];
}

interface RowState {
  id: string;
  name: string;
  kind: UpstreamProviderKind | null;
  enabled: boolean;
}

const props = defineProps<{
  available: UpstreamOption[];
  title: string;
  inheritDescription: string;
}>();

const value = defineModel<UpstreamPickerValue>({ required: true });

const rows = ref<RowState[]>([]);

const reset = () => {
  const orderedIds = value.value.ids;
  const orderedSet = new Set(orderedIds);
  const rest = props.available.filter(u => !orderedSet.has(u.id));
  rows.value = [
    ...orderedIds.map(id => {
      const u = props.available.find(x => x.id === id);
      return { id, name: u?.name ?? `Unknown (${id})`, kind: u?.kind ?? null, enabled: true };
    }),
    ...rest.map(u => ({ id: u.id, name: u.name, kind: u.kind, enabled: false })),
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

interface ProviderMeta { tone: 'amber' | 'emerald' | 'cyan' | 'rose' | 'zinc'; label: string }
const providerMeta = (kind: UpstreamProviderKind | null): ProviderMeta => {
  // The row's kind goes null when an upstream id in the saved value list
  // no longer matches anything in `available` (e.g. a deleted upstream).
  if (kind === null) return { tone: 'zinc', label: 'Unknown' };
  switch (kind) {
  case 'custom': return { tone: 'amber', label: 'Custom' };
  case 'azure': return { tone: 'emerald', label: 'Azure' };
  case 'copilot': return { tone: 'cyan', label: 'Copilot' };
  case 'codex': return { tone: 'cyan', label: 'Codex' };
  case 'claude-code': return { tone: 'rose', label: 'Claude Code' };
  case 'ollama': return { tone: 'rose', label: 'Ollama' };
  case 'cursor': return { tone: 'cyan', label: 'Cursor' };
  }
  return assertNever(kind);
};
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
          <Badge :tone="providerMeta(row.kind).tone" size="sm" class="shrink-0 !rounded !uppercase tracking-wide">{{ providerMeta(row.kind).label }}</Badge>
          <span class="min-w-0 flex-1 truncate text-sm text-white">{{ row.name }}</span>
          <code class="text-xs text-gray-500">{{ row.id }}</code>
        </li>
      </template>
    </Sortable>
  </div>
</template>
