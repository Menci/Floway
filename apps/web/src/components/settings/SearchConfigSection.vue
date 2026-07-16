<script setup lang="ts">
import { computed, ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { ControlPlaneModel, SearchConfig, UpstreamRecord } from '../../api/types.ts';
import { useAuthStore } from '../../stores/auth.ts';
import SecretInput from '../shared/SecretInput.vue';
import { Button, Input, Select, Switch } from '@floway-dev/ui';

interface SearchTestResult {
  ok: boolean;
  provider: string;
  query: string;
  results?: Array<{ title: string; url: string; previewText: string; pageAge?: string }>;
  error?: { code: string; message: string };
}

// Single source of truth for the provider list. `apiKey` reads the
// per-provider config slot; `set` writes a new apiKey back into that slot.
// Both are absent for the `disabled` option, which has no credential field.
interface ProviderOption {
  value: SearchConfig['provider'];
  label: string;
  description: string;
  apiKey?: (config: SearchConfig) => string;
  set?: (config: SearchConfig, apiKey: string) => SearchConfig;
}

// Presented as a dropdown rather than radio cards so adding a fifth
// provider stays a one-line entry; the existing per-option description
// slot in the shared Select also keeps the explanation inside the
// popover instead of permanently consuming vertical space.
const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    value: 'disabled',
    label: 'Disabled',
    description: 'No upstream web search provider.',
  },
  {
    value: 'tavily',
    label: 'Tavily',
    description: 'Gateway-managed Tavily API key.',
    apiKey: config => config.tavily.apiKey,
    set: (config, apiKey) => ({ ...config, tavily: { apiKey } }),
  },
  {
    value: 'microsoft-grounding',
    label: 'Microsoft Grounding',
    description: 'Gateway-managed Microsoft Grounding key.',
    apiKey: config => config.microsoftGrounding.apiKey,
    set: (config, apiKey) => ({ ...config, microsoftGrounding: { apiKey } }),
  },
  {
    value: 'jina',
    label: 'Jina',
    description: 'Gateway-managed Jina API key (s.jina.ai + r.jina.ai).',
    apiKey: config => config.jina.apiKey,
    set: (config, apiKey) => ({ ...config, jina: { apiKey } }),
  },
];

const props = defineProps<{
  initialConfig: SearchConfig;
  initialError?: string | null;
  upstreams: Array<Pick<UpstreamRecord, 'id' | 'name' | 'kind' | 'enabled'>>;
  models: ControlPlaneModel[];
}>();

const auth = useAuthStore();
const api = useApi();

const draft = ref<SearchConfig>(props.initialConfig);
const error = ref<string | null>(props.initialError ?? null);
const saving = ref(false);
const testing = ref(false);
const testResult = ref<SearchTestResult | null>(null);

const chatModelsForUpstream = (upstreamId: string) => props.models.filter(model =>
  model.kind === 'chat' && model.upstreams.some(upstream => upstream.id === upstreamId));

const eligibleUpstreams = computed(() => props.upstreams.filter(upstream =>
  upstream.enabled
  && (upstream.kind === 'codex' || upstream.kind === 'custom')
  && chatModelsForUpstream(upstream.id).length > 0));
const alphaUpstreamOptions = computed(() => eligibleUpstreams.value.map(upstream => ({
  value: upstream.id,
  label: upstream.name,
  description: upstream.kind === 'codex' ? 'ChatGPT Codex subscription' : 'Custom OpenAI-compatible upstream',
})));
const alphaModelOptions = computed(() => chatModelsForUpstream(draft.value.passthroughOpenAiSearch.upstreamId)
  .map(model => ({ value: model.id, label: model.display_name })));

const activeOption = computed(() => PROVIDER_OPTIONS.find(option => option.value === draft.value.provider) ?? PROVIDER_OPTIONS[0]);

const setProvider = (provider: SearchConfig['provider']) => {
  draft.value = { ...draft.value, provider };
};

const searchCredentialLabel = computed(() => activeOption.value.apiKey ? `${activeOption.value.label} API key` : 'Credential');

const searchCredentialValue = computed(() => activeOption.value.apiKey?.(draft.value) ?? '');

const setSearchCredentialValue = (v: string) => {
  const option = activeOption.value;
  if (option.set) {
    draft.value = option.set(draft.value, v);
  }
};

const setAlphaUpstream = (upstreamId: string, preferredModel?: string) => {
  const models = chatModelsForUpstream(upstreamId);
  const model = models.find(candidate => candidate.id === preferredModel) ?? models[0];
  if (model === undefined) throw new Error(`OpenAI search upstream ${upstreamId} has no chat model`);
  draft.value = {
    ...draft.value,
    passthroughOpenAiSearch: { enabled: true, upstreamId, model: model.id },
  };
};

const setAlphaModel = (model: string) => {
  draft.value = {
    ...draft.value,
    passthroughOpenAiSearch: { ...draft.value.passthroughOpenAiSearch, model },
  };
};

const setPassthroughOpenAiSearch = (enabled: boolean) => {
  if (!enabled) {
    draft.value = {
      ...draft.value,
      passthroughOpenAiSearch: { ...draft.value.passthroughOpenAiSearch, enabled: false },
    };
    return;
  }
  const selected = eligibleUpstreams.value.find(upstream => upstream.id === draft.value.passthroughOpenAiSearch.upstreamId)
    ?? eligibleUpstreams.value[0];
  if (selected === undefined) throw new Error('OpenAI search passthrough requires an eligible upstream');
  setAlphaUpstream(selected.id, draft.value.passthroughOpenAiSearch.model);
};

const save = async () => {
  saving.value = true;
  const { error: err } = await callApi(() => api.api['search-config'].$put({ json: draft.value }));
  saving.value = false;
  if (err) {
    window.alert(`Save failed: ${err.message}`);
    return;
  }
  error.value = null;
};

// The test endpoint returns the same structured body at both 200 and 400, so
// we read the body directly rather than going through callApi (which collapses
// non-2xx into a flat error string and discards `query`/`error.code`).
const test = async () => {
  testing.value = true;
  testResult.value = null;
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth.authToken) headers['x-floway-session'] = auth.authToken;
    const resp = await fetch('/api/search-config/test', {
      method: 'POST',
      headers,
      body: JSON.stringify(draft.value),
    });
    testResult.value = await resp.json() as SearchTestResult;
  } catch (e) {
    testResult.value = {
      ok: false,
      provider: draft.value.provider,
      query: '',
      error: { code: 'NETWORK', message: e instanceof Error ? e.message : String(e) },
    };
  } finally {
    testing.value = false;
  }
};
</script>

<template>
  <div class="glass-card p-5 sm:p-6 animate-in delay-2">
    <div class="mb-4">
      <h3 class="text-white font-semibold mb-1">Web Search</h3>
      <p class="text-sm text-gray-400">Configure the search provider used by gateway-managed Messages and Responses web search.</p>
    </div>

    <p v-if="error" class="mb-4 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">{{ error }}</p>

    <div class="grid grid-cols-1 gap-5 sm:grid-cols-2">
      <div>
        <label class="mb-1.5 block text-xs font-medium text-gray-500">Search Provider</label>
        <Select
          :model-value="draft.provider"
          :options="PROVIDER_OPTIONS"
          @update:model-value="v => v !== undefined && setProvider(v)"
        >
          <template #description="{ option }">
            <p class="text-[11px] text-gray-500">{{ option.description }}</p>
          </template>
        </Select>
      </div>
      <div>
        <label class="mb-1.5 block text-xs font-medium text-gray-500">{{ searchCredentialLabel }}</label>
        <SecretInput
          v-if="activeOption.apiKey"
          :placeholder="`${activeOption.label} API key`"
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
    </div>

    <div class="mt-5 border-t border-white/[0.06] pt-5">
      <div class="flex items-start justify-between gap-4">
        <div>
          <label class="text-sm font-medium text-white">Passthrough OpenAI search (/alpha/search and Responses hosted tool)</label>
          <p class="mt-1 text-xs text-gray-500">Use a selected upstream (with /alpha/search support) instead of the general search provider for OpenAI search calls. Anthropic Messages API is not affected by this option.</p>
        </div>
        <Switch
          :model-value="draft.passthroughOpenAiSearch.enabled"
          :disabled="eligibleUpstreams.length === 0"
          @update:model-value="value => setPassthroughOpenAiSearch(value === true)"
        />
      </div>

      <div v-if="draft.passthroughOpenAiSearch.enabled" class="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Search Upstream</label>
          <Select
            :model-value="draft.passthroughOpenAiSearch.upstreamId"
            :options="alphaUpstreamOptions"
            @update:model-value="value => value !== undefined && setAlphaUpstream(value)"
          >
            <template #description="{ option }">
              <p class="text-[11px] text-gray-500">{{ option.description }}</p>
            </template>
          </Select>
        </div>
        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Search Model</label>
          <Select
            :model-value="draft.passthroughOpenAiSearch.model"
            :options="alphaModelOptions"
            @update:model-value="value => value !== undefined && setAlphaModel(value)"
          />
        </div>
      </div>

      <p v-else-if="eligibleUpstreams.length === 0" class="mt-3 text-xs text-gray-500">Add an enabled Codex or Custom upstream with a chat model to use OpenAI search passthrough.</p>
    </div>

    <div class="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <Button :loading="saving" @click="save">Save Search Config</Button>
      <Button variant="secondary" :loading="testing" :disabled="draft.provider === 'disabled'" @click="test">Test Search</Button>
      <p v-if="draft.provider === 'disabled'" class="text-xs text-gray-500">Search testing is disabled until a provider is selected.</p>
    </div>

    <div v-if="testResult" class="mt-5 bg-surface-900 rounded-xl border border-white/5 p-4">
      <div class="flex flex-col gap-3 mb-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <p class="text-sm font-medium text-white">Search Test Result</p>
          <p class="text-xs text-gray-500">Provider: <span>{{ testResult.provider }}</span> · Query: <span>{{ testResult.query }}</span></p>
        </div>
        <span
          class="text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded-full"
          :class="testResult.ok ? 'bg-accent-emerald/10 text-accent-emerald' : 'bg-red-500/10 text-red-400'"
        >{{ testResult.ok ? 'OK' : 'Error' }}</span>
      </div>

      <div v-if="testResult.ok" class="space-y-3">
        <div
          v-for="result in testResult.results ?? []"
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
        <p class="text-sm text-red-300 font-medium">{{ testResult.error?.code }}</p>
        <p class="text-sm text-gray-300 mt-1">{{ testResult.error?.message }}</p>
      </div>
    </div>
  </div>
</template>
