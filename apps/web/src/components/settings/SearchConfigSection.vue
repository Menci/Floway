<script setup lang="ts">
import { Button, Input, Spinner } from '@floway-dev/ui';
import { computed, ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { SearchConfig } from '../../api/types.ts';
import { useAuthStore } from '../../stores/auth.ts';

interface SearchTestResult {
  ok: boolean;
  provider: string;
  query: string;
  results?: Array<{ title: string; url: string; previewText: string; pageAge?: string }>;
  error?: { code: string; message: string };
}

const props = defineProps<{
  initialConfig: SearchConfig;
  initialError?: string | null;
}>();

const auth = useAuthStore();
const api = useApi();

const draft = ref<SearchConfig>(props.initialConfig);
const error = ref<string | null>(props.initialError ?? null);
const searchConfigSaving = ref(false);
const searchConfigTesting = ref(false);
const searchConfigTestResult = ref<SearchTestResult | null>(null);

const setSearchConfigProvider = (provider: SearchConfig['provider']) => {
  draft.value = { ...draft.value, provider };
};

const searchCredentialLabel = computed(() => {
  switch (draft.value.provider) {
  case 'tavily': return 'Tavily API key';
  case 'microsoft-grounding': return 'Microsoft Grounding API key';
  case 'disabled':
  default: return 'Credential';
  }
});

const searchCredentialValue = computed(() => {
  switch (draft.value.provider) {
  case 'tavily': return draft.value.tavily.apiKey;
  case 'microsoft-grounding': return draft.value.microsoftGrounding.apiKey;
  default: return '';
  }
});

const setSearchCredentialValue = (v: string) => {
  if (draft.value.provider === 'tavily') {
    draft.value = { ...draft.value, tavily: { apiKey: v } };
  } else if (draft.value.provider === 'microsoft-grounding') {
    draft.value = { ...draft.value, microsoftGrounding: { apiKey: v } };
  }
};

const saveSearchConfig = async () => {
  searchConfigSaving.value = true;
  const { error: err } = await callApi(() => api.api['search-config'].$put({ json: draft.value }));
  searchConfigSaving.value = false;
  if (err) {
    window.alert(`Save failed: ${err.message}`);
    return;
  }
  error.value = null;
};

// The test endpoint returns the same structured body at both 200 and 400, so
// we read the body directly rather than going through callApi (which collapses
// non-2xx into a flat error string and discards `query`/`error.code`).
const testSearchConfig = async () => {
  searchConfigTesting.value = true;
  searchConfigTestResult.value = null;
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth.authKey) headers['x-api-key'] = auth.authKey;
    const resp = await fetch('/api/search-config/test', {
      method: 'POST',
      headers,
      body: JSON.stringify(draft.value),
    });
    searchConfigTestResult.value = await resp.json() as SearchTestResult;
  } catch (e) {
    searchConfigTestResult.value = {
      ok: false,
      provider: draft.value.provider,
      query: '',
      error: { code: 'NETWORK', message: e instanceof Error ? e.message : String(e) },
    };
  } finally {
    searchConfigTesting.value = false;
  }
};
</script>

<template>
  <div class="glass-card p-5 sm:p-6 animate-in delay-2">
    <div class="mb-4">
      <h3 class="text-white font-semibold mb-1">Web Search</h3>
      <p class="text-sm text-gray-400">Configure the search provider used by Anthropic Messages web search.</p>
    </div>

    <p v-if="error" class="mb-4 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">{{ error }}</p>

    <div class="space-y-5">
      <div>
        <p class="text-xs font-medium text-gray-500 uppercase tracking-widest mb-3">Search Provider</p>
        <div class="grid grid-cols-1 gap-3">
          <label
            class="flex items-center gap-3 rounded-xl border p-4 transition-all cursor-pointer"
            :class="draft.provider === 'disabled' ? 'border-accent-cyan/50 bg-accent-cyan/5' : 'border-white/10 hover:border-white/20'"
          >
            <input
              type="radio"
              name="search-provider"
              value="disabled"
              class="accent-accent-cyan"
              :checked="draft.provider === 'disabled'"
              @change="setSearchConfigProvider('disabled')"
            >
            <div>
              <p class="text-sm font-medium text-white">Disabled</p>
              <p class="text-xs text-gray-500">No upstream web search provider</p>
            </div>
          </label>

          <label
            class="flex items-center gap-3 rounded-xl border p-4 transition-all cursor-pointer"
            :class="draft.provider === 'tavily' ? 'border-accent-cyan/50 bg-accent-cyan/5' : 'border-white/10 hover:border-white/20'"
          >
            <input
              type="radio"
              name="search-provider"
              value="tavily"
              class="accent-accent-cyan"
              :checked="draft.provider === 'tavily'"
              @change="setSearchConfigProvider('tavily')"
            >
            <div>
              <p class="text-sm font-medium text-white">Tavily</p>
              <p class="text-xs text-gray-500">Gateway-managed Tavily API key</p>
            </div>
          </label>

          <label
            class="flex items-center gap-3 rounded-xl border p-4 transition-all cursor-pointer"
            :class="draft.provider === 'microsoft-grounding' ? 'border-accent-cyan/50 bg-accent-cyan/5' : 'border-white/10 hover:border-white/20'"
          >
            <input
              type="radio"
              name="search-provider"
              value="microsoft-grounding"
              class="accent-accent-cyan"
              :checked="draft.provider === 'microsoft-grounding'"
              @change="setSearchConfigProvider('microsoft-grounding')"
            >
            <div>
              <p class="text-sm font-medium text-white">Microsoft Grounding</p>
              <p class="text-xs text-gray-500">Gateway-managed Microsoft Grounding key</p>
            </div>
          </label>
        </div>
      </div>

      <div>
        <label class="block text-xs font-medium text-gray-500 uppercase tracking-widest mb-2">{{ searchCredentialLabel }}</label>
        <Input
          v-if="draft.provider !== 'disabled'"
          type="password"
          autocomplete="off"
          :placeholder="draft.provider === 'tavily' ? 'Tavily API key' : 'Microsoft Grounding API key'"
          :model-value="searchCredentialValue"
          class="w-full"
          @update:model-value="setSearchCredentialValue"
        />
        <Input
          v-else
          type="text"
          model-value="No credential needed when disabled"
          disabled
          class="w-full"
        />
      </div>

      <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <Button :loading="searchConfigSaving" @click="saveSearchConfig">Save Search Config</Button>
        <Button variant="secondary" :loading="searchConfigTesting" :disabled="draft.provider === 'disabled'" @click="testSearchConfig">Test Search</Button>
        <p v-if="draft.provider === 'disabled'" class="text-xs text-gray-500">Search testing is disabled until a provider is selected.</p>
      </div>

      <div v-if="searchConfigTestResult" class="bg-surface-900 rounded-xl border border-white/5 p-4">
        <div class="flex flex-col gap-3 mb-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="min-w-0">
            <p class="text-sm font-medium text-white">Search Test Result</p>
            <p class="text-xs text-gray-500">Provider: <span>{{ searchConfigTestResult.provider }}</span> · Query: <span>{{ searchConfigTestResult.query }}</span></p>
          </div>
          <span
            class="text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full"
            :class="searchConfigTestResult.ok ? 'bg-accent-emerald/10 text-accent-emerald' : 'bg-red-500/10 text-red-400'"
          >{{ searchConfigTestResult.ok ? 'OK' : 'Error' }}</span>
        </div>

        <div v-if="searchConfigTestResult.ok" class="space-y-3">
          <div
            v-for="result in searchConfigTestResult.results ?? []"
            :key="result.url + result.title"
            class="rounded-lg border border-white/5 bg-surface-800 p-3"
          >
            <div class="flex items-start justify-between gap-3 mb-1">
              <div>
                <a :href="result.url" target="_blank" class="text-sm font-medium text-accent-cyan hover:underline break-words">{{ result.title }}</a>
                <p class="text-[11px] text-gray-500 break-all">{{ result.url }}</p>
              </div>
              <span v-if="result.pageAge" class="text-[10px] text-gray-600 uppercase tracking-widest">{{ result.pageAge }}</span>
            </div>
            <p class="text-sm text-gray-300 leading-relaxed">{{ result.previewText }}</p>
          </div>
        </div>

        <div v-else class="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
          <p class="text-sm text-red-300 font-medium">{{ searchConfigTestResult.error?.code }}</p>
          <p class="text-sm text-gray-300 mt-1">{{ searchConfigTestResult.error?.message }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
