<script setup lang="ts">
import { Spinner } from '@floway-dev/ui';

import { callApi, useApi } from '../../api/client.ts';
import type { ControlPlaneModel, UpstreamRecord } from '../../api/types.ts';
import UpstreamRow from './UpstreamRow.vue';

const props = defineProps<{
  loading: boolean;
  ordered: UpstreamRecord[];
  models: ControlPlaneModel[] | null;
}>();

const emit = defineEmits<{
  'add': [];
  'edit': [record: UpstreamRecord];
  'changed': [];
  'update:ordered': [list: UpstreamRecord[]];
}>();

const api = useApi();

// Mirrors baseline's upstreamModelCount(): Azure uses deployments.length so the
// card still renders a useful number for a freshly created upstream that has
// not been probed yet; the other providers count public models that have a
// binding pointing at this upstream row.
const modelCountFor = (record: UpstreamRecord): number => {
  if (record.provider === 'azure') {
    const cfg = record.config as { deployments?: unknown[] };
    return cfg.deployments?.length ?? 0;
  }
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
      callApi(() => api.api.upstreams[':id'].$patch({ param: { id }, json: { sort_order: newOrder } })),
    ),
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
      <button class="btn-primary !py-2.5 !px-3 text-xs whitespace-nowrap" @click="emit('add')">Add Upstream</button>
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
