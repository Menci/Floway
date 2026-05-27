<script setup lang="ts">
import { Spinner } from '@floway-dev/ui';
import { computed, ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';

interface ExportPayload {
  version: number;
  exportedAt?: string;
  data: {
    apiKeys?: unknown[];
    upstreams?: unknown[];
    usage?: unknown[];
    searchUsage?: unknown[];
    performance?: unknown[];
  };
}

const api = useApi();

withDefaults(defineProps<{
  framed?: boolean;
}>(), {
  framed: true,
});

const importFile = ref<File | null>(null);
const importPayload = ref<ExportPayload | null>(null);
const importMode = ref<'merge' | 'replace'>('merge');
const importLoading = ref(false);
const importError = ref<string | null>(null);
const importStatus = ref<string | null>(null);

const handleImportFile = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  importError.value = null;
  importStatus.value = null;
  importFile.value = file;
  try {
    const text = await file.text();
    const json = JSON.parse(text) as ExportPayload;
    if (json.version !== 2 || !json.data) throw new Error('Unsupported export file: expected version 2 with a `data` field');
    importPayload.value = json;
  } catch (e: unknown) {
    importError.value = e instanceof Error ? e.message : String(e);
    importPayload.value = null;
  }
};

const importPreview = computed(() => {
  if (!importPayload.value) return { ready: false, apiKeys: 0, upstreams: 0, usage: 0, searchUsage: 0, performance: 0, exportedAt: null as string | null };
  const d = importPayload.value.data;
  return {
    ready: true,
    apiKeys: d.apiKeys?.length ?? 0,
    upstreams: d.upstreams?.length ?? 0,
    usage: d.usage?.length ?? 0,
    searchUsage: d.searchUsage?.length ?? 0,
    performance: d.performance?.length ?? 0,
    exportedAt: importPayload.value.exportedAt ?? null,
  };
});

const doImport = async () => {
  if (!importPayload.value) return;
  if (importMode.value === 'replace' && !window.confirm('This DELETES all existing data and replaces it with the imported file. Continue?')) return;
  importLoading.value = true;
  importError.value = null;
  importStatus.value = null;
  const { error } = await callApi(
    () => api.api.import.$post({
      json: { version: 2 as const, mode: importMode.value, data: importPayload.value!.data },
    }),
  );
  importLoading.value = false;
  if (error) {
    importError.value = error.message;
    return;
  }
  importStatus.value = 'Import complete. Refresh other tabs to see changes.';
  importPayload.value = null;
  importFile.value = null;
};
</script>

<template>
  <div :class="framed && 'glass-card p-5 sm:p-6 animate-in delay-3'">
    <h3 class="text-white font-semibold mb-1">Import Data</h3>
    <p class="text-sm text-gray-400 mb-4">Restore data from a previously exported JSON file.</p>

    <div class="mb-4">
      <label
        class="block w-full cursor-pointer border-2 border-dashed border-white/10 hover:border-accent-cyan/30 rounded-xl p-8 text-center transition-colors"
        :class="importFile ? 'border-accent-cyan/40 bg-accent-cyan/5' : ''"
      >
        <input type="file" accept=".json" class="hidden" @change="handleImportFile">
        <div v-if="!importFile">
          <svg class="w-8 h-8 mx-auto mb-2 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <p class="text-sm text-gray-400">Click to select a JSON export file</p>
        </div>
        <div v-else>
          <svg class="w-8 h-8 mx-auto mb-2 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <p class="text-sm text-white break-all">{{ importFile.name }}</p>
          <p class="text-xs text-gray-500 mt-1">Exported: {{ importPreview.exportedAt ? new Date(importPreview.exportedAt).toLocaleString() : 'unknown' }}</p>
        </div>
      </label>
    </div>

    <div v-if="importError" class="mb-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">{{ importError }}</div>
    <div v-if="importStatus" class="mb-3 rounded-md border border-accent-emerald/30 bg-accent-emerald/10 px-3 py-2 text-xs text-accent-emerald">{{ importStatus }}</div>

    <div v-if="importPreview.ready">
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
        <div class="bg-surface-800 rounded-lg p-3 text-center">
          <p class="text-xs text-gray-500 mb-1">API Keys</p>
          <p class="text-lg font-bold font-mono text-white">{{ importPreview.apiKeys }}</p>
        </div>
        <div class="bg-surface-800 rounded-lg p-3 text-center">
          <p class="text-xs text-gray-500 mb-1">Upstream Records</p>
          <p class="text-lg font-bold font-mono text-white">{{ importPreview.upstreams }}</p>
        </div>
        <div class="bg-surface-800 rounded-lg p-3 text-center">
          <p class="text-xs text-gray-500 mb-1">Usage Records</p>
          <p class="text-lg font-bold font-mono text-white">{{ importPreview.usage }}</p>
        </div>
        <div class="bg-surface-800 rounded-lg p-3 text-center">
          <p class="text-xs text-gray-500 mb-1">Search Usage Records</p>
          <p class="text-lg font-bold font-mono text-white">{{ importPreview.searchUsage }}</p>
        </div>
        <div class="bg-surface-800 rounded-lg p-3 text-center">
          <p class="text-xs text-gray-500 mb-1">Performance Records</p>
          <p class="text-lg font-bold font-mono text-white">{{ importPreview.performance }}</p>
        </div>
      </div>

      <div class="flex flex-col gap-3 mb-4 sm:flex-row">
        <button
          class="flex-1 p-3 rounded-lg border text-left transition-all"
          :class="importMode === 'merge' ? 'border-accent-cyan/50 bg-accent-cyan/5' : 'border-white/10 hover:border-white/20'"
          @click="importMode = 'merge'"
        >
          <p class="text-sm font-medium" :class="importMode === 'merge' ? 'text-accent-cyan' : 'text-white'">Merge</p>
          <p class="text-xs text-gray-500 mt-0.5">Keep existing data, add/update imported records</p>
        </button>
        <button
          class="flex-1 p-3 rounded-lg border text-left transition-all"
          :class="importMode === 'replace' ? 'border-red-400/50 bg-red-400/5' : 'border-white/10 hover:border-white/20'"
          @click="importMode = 'replace'"
        >
          <p class="text-sm font-medium" :class="importMode === 'replace' ? 'text-red-400' : 'text-white'">Replace</p>
          <p class="text-xs text-gray-500 mt-0.5">Wipe all existing data and restore from file</p>
        </button>
      </div>

      <div v-if="importMode === 'replace'" class="bg-red-500/10 border border-red-500/20 rounded-lg p-3 mb-4">
        <p class="text-sm text-red-400">This will permanently delete all existing data before importing. This cannot be undone.</p>
      </div>

      <button
        class="btn-primary w-full sm:w-auto"
        :class="importMode === 'replace' ? 'bg-red-500/80 hover:bg-red-500' : ''"
        :disabled="importLoading"
        @click="doImport"
      >
        <span v-if="!importLoading" class="flex items-center gap-2">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          <span>{{ importMode === 'replace' ? 'Replace All Data' : 'Merge Data' }}</span>
        </span>
        <span v-else class="flex items-center gap-2"><Spinner class="h-4 w-4" /> Importing…</span>
      </button>
    </div>
  </div>
</template>
