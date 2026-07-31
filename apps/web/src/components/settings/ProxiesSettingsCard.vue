<script setup lang="ts">
import { computed } from 'vue';

import ProxyRow from './ProxyRow.vue';
import { callApiNoContent, useApi } from '../../api/client.ts';
import type { ProxyConflictBody, ProxyRecord } from '../../api/types.ts';
import { useProxiesStore } from '../../composables/useProxies.ts';
import { useUpstreamsStore } from '../../composables/useUpstreams.ts';
import { Spinner } from '@floway-dev/ui';

const emit = defineEmits<{
  'add': [];
  'edit': [record: ProxyRecord];
  'changed': [];
}>();

const api = useApi();
const proxiesStore = useProxiesStore();
const upstreamsStore = useUpstreamsStore();

const proxies = computed<ProxyRecord[]>(() => proxiesStore.proxies.value ?? []);

const upstreamNames = computed<Map<string, string>>(() => {
  const map = new Map<string, string>();
  for (const u of upstreamsStore.upstreams.value ?? []) map.set(u.id, u.name);
  return map;
});

const deleteProxy = async (record: ProxyRecord) => {
  if (!window.confirm(`Delete proxy "${record.name}"?`)) return;
  const { error } = await callApiNoContent(() => api.api.proxies[':id'].$delete({ param: { id: record.id } }));
  if (error) {
    if (error.status === 409) {
      const refs = (error.raw as ProxyConflictBody | undefined)?.referencing_upstream_ids ?? [];
      const names = refs.map(id => upstreamNames.value.get(id) ?? id).join(', ');
      window.alert(`This proxy is referenced by upstreams: ${names}. Remove it from those upstreams first.`);
      return;
    }
    window.alert(`Delete failed: ${error.message}`);
    return;
  }
  emit('changed');
};
</script>

<template>
  <div class="glass-card p-5 sm:p-6 animate-in delay-1">
    <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <h3 class="text-white font-semibold mb-1">Proxies</h3>
        <p class="text-sm text-gray-400">Outbound proxies referenced by per-upstream fallback lists.</p>
      </div>
      <button class="btn-primary !py-2.5 !px-3 text-xs whitespace-nowrap" @click="emit('add')">Add Proxy</button>
    </div>

    <!-- Surface a list-load error so an empty render after a failure isn't
         confused with the "no proxies configured" empty state. -->
    <p v-if="proxiesStore.error.value" class="mb-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
      Failed to load proxies: {{ proxiesStore.error.value }}
    </p>

    <p v-if="!proxiesStore.error.value && proxies.length === 0" class="text-sm text-gray-500">
      No proxies configured. Add a proxy to route upstream traffic through it.
    </p>

    <div v-else-if="proxies.length > 0" class="space-y-2">
      <ProxyRow
        v-for="proxy in proxies"
        :key="proxy.id"
        :proxy="proxy"
        @edit="emit('edit', proxy)"
        @delete="deleteProxy(proxy)"
      />
    </div>

    <Spinner v-if="proxiesStore.loading.value && proxies.length > 0" class="mt-3 h-4 w-4 text-gray-500" />
  </div>
</template>
