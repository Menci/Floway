<script setup lang="ts">
import {
  DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger,
} from 'reka-ui';

import UpstreamRow from './UpstreamRow.vue';
import { callApi, useApi } from '../../api/client.ts';
import type { ControlPlaneModel, UpstreamProviderKind, UpstreamRecord } from '../../api/types.ts';
import { PROVIDER_META, providerSwatchClass } from '../upstreams/provider-meta.ts';
import { Spinner } from '@floway-dev/ui';

const props = defineProps<{
  loading: boolean;
  ordered: UpstreamRecord[];
  models: ControlPlaneModel[] | null;
}>();

const emit = defineEmits<{
  'add': [kind: UpstreamProviderKind];
  'edit': [record: UpstreamRecord];
  'changed': [];
  'update:ordered': [list: UpstreamRecord[]];
}>();

const api = useApi();

// Azure counts its configured models directly so the card still renders a
// useful number for a freshly created upstream that has not been probed yet;
// the other providers count public models that are served by this upstream
// row.
const modelCountFor = (record: UpstreamRecord): number => {
  if (record.provider === 'azure') return record.config.models.length;
  const list = props.models ?? [];
  return list.filter(m => m.upstreams.some(b => b.id === record.id)).length;
};

const persistReorder = async (next: UpstreamRecord[]) => {
  const patches = next
    .map((u, i) => ({ id: u.id, oldOrder: u.sort_order, newOrder: i }))
    .filter(({ oldOrder, newOrder }) => oldOrder !== newOrder);
  if (patches.length === 0) return;
  const results = await Promise.all(
    patches.map(({ id, newOrder }) =>
      callApi(() => api.api.upstreams[':id'].$patch({ param: { id }, json: { sort_order: newOrder } }))),
  );
  const failed = results.find(r => r.error);
  if (failed?.error) window.alert(`Reorder failed: ${failed.error.message}`);
  emit('changed');
};

const setEnabled = async (record: UpstreamRecord, next: boolean) => {
  const { error } = await callApi(
    () => api.api.upstreams[':id'].$patch({ param: { id: record.id }, json: { enabled: next } }),
  );
  if (error) {
    window.alert(`Toggle failed: ${error.message}`);
    return;
  }
  emit('changed');
};

const deleteUpstream = async (record: UpstreamRecord) => {
  if (!window.confirm(`Delete upstream "${record.name}"?`)) return;
  const { error } = await callApi(() => api.api.upstreams[':id'].$delete({ param: { id: record.id } }));
  if (error) {
    window.alert(`Delete failed: ${error.message}`);
    return;
  }
  emit('changed');
};

const moveUpstream = async (id: string, direction: -1 | 1) => {
  const list = [...props.ordered];
  const idx = list.findIndex(u => u.id === id);
  const target = idx + direction;
  if (idx === -1 || target < 0 || target >= list.length) return;
  const tmp = list[idx]!;
  list[idx] = list[target]!;
  list[target] = tmp;
  emit('update:ordered', list);
  await persistReorder(list);
};

const moveDisabled = (id: string, direction: -1 | 1) => {
  const idx = props.ordered.findIndex(u => u.id === id);
  const target = idx + direction;
  return idx === -1 || target < 0 || target >= props.ordered.length;
};
</script>

<template>
  <div class="glass-card p-5 sm:p-6 animate-in delay-1">
    <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <h3 class="text-white font-semibold mb-1">Upstreams</h3>
        <p class="text-sm text-gray-400">Ordered providers used for model routing and fallback.</p>
      </div>
      <DropdownMenuRoot>
        <DropdownMenuTrigger class="btn-primary !py-2.5 !px-3 text-xs whitespace-nowrap inline-flex items-center gap-1.5">
          Add Upstream
          <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent
            align="end"
            :side-offset="4"
            class="z-50 min-w-[16rem] overflow-hidden rounded-[10px] border border-white/[0.06] bg-surface-800 p-1 text-white shadow-xl"
          >
            <DropdownMenuItem
              v-for="meta in PROVIDER_META"
              :key="meta.kind"
              class="flex cursor-pointer select-none items-center gap-3 rounded-sm px-2 py-2 outline-none data-[highlighted]:bg-white/[0.05]"
              @select="emit('add', meta.kind)"
            >
              <span
                class="grid size-8 shrink-0 place-items-center rounded-md"
                :class="providerSwatchClass(meta.kind)"
              >
                <i :class="[meta.icon, 'size-4']" />
              </span>
              <span class="min-w-0">
                <span class="block text-sm font-semibold text-white">{{ meta.label }}</span>
                <span class="mt-0.5 block text-xs text-gray-400">{{ meta.subtitle }}</span>
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>
    </div>

    <p v-if="ordered.length === 0" class="text-sm text-gray-500">
      No upstreams configured. Add an upstream to serve models.
    </p>

    <div v-else class="space-y-2">
      <UpstreamRow
        v-for="upstream in ordered"
        :key="upstream.id"
        :upstream="upstream"
        :model-count="modelCountFor(upstream)"
        :move-up-disabled="moveDisabled(upstream.id, -1)"
        :move-down-disabled="moveDisabled(upstream.id, 1)"
        @toggle-enabled="next => setEnabled(upstream, next)"
        @move-up="moveUpstream(upstream.id, -1)"
        @move-down="moveUpstream(upstream.id, 1)"
        @edit="emit('edit', upstream)"
        @delete="deleteUpstream(upstream)"
      />
    </div>

    <Spinner v-if="loading && ordered.length > 0" class="mt-3 h-4 w-4 text-gray-500" />
  </div>
</template>
