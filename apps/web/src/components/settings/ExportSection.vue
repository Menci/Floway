<script setup lang="ts">
import { Checkbox, Spinner } from '@floway-dev/ui';
import { ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';

interface ExportPayload {
  version: number;
  exportedAt?: string;
  data: Record<string, unknown>;
}

const api = useApi();

withDefaults(defineProps<{
  framed?: boolean;
}>(), {
  framed: true,
});

const exportIncludePerformance = ref(false);
const exportLoading = ref(false);
const error = ref<string | null>(null);

const exportData = async () => {
  exportLoading.value = true;
  error.value = null;
  const { data, error: err } = await callApi<ExportPayload>(
    () => api.api.export.$get({ query: exportIncludePerformance.value ? { include_performance: '1' } : {} }),
  );
  exportLoading.value = false;
  if (err) {
    error.value = err.message;
    return;
  }
  if (!data) return;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `floway-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
};
</script>

<template>
  <div :class="framed && 'glass-card p-5 sm:p-6 animate-in delay-2'">
    <h3 class="text-white font-semibold mb-1">Export Data</h3>
    <p class="text-sm text-gray-400 mb-4">Download API keys, upstreams, web search config, and usage data as a JSON file.</p>
    <label class="mb-4 flex items-start gap-3 rounded-md border border-white/5 bg-surface-800/50 p-3">
      <Checkbox v-model="exportIncludePerformance" class="mt-0.5" />
      <span>
        <span class="block text-sm font-medium text-gray-200">Include Performance Telemetry</span>
        <span class="block text-xs text-gray-500">Adds latency histogram history to the export.</span>
      </span>
    </label>
    <button class="btn-primary" :disabled="exportLoading" @click="exportData">
      <span v-if="!exportLoading" class="flex items-center gap-2">
        <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        Export JSON
      </span>
      <span v-else class="flex items-center gap-2"><Spinner class="h-4 w-4" /> Exporting…</span>
    </button>

    <p v-if="error" class="mt-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">{{ error }}</p>
  </div>
</template>
