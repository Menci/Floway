<script setup lang="ts">
import { ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { CodexUltraConfig } from '../../api/types.ts';
import { Button, Switch } from '@floway-dev/ui';

const props = defineProps<{
  initialConfig: CodexUltraConfig;
  initialError?: string | null;
}>();

const api = useApi();
const draft = ref<CodexUltraConfig>({ ...props.initialConfig });
const error = ref<string | null>(props.initialError ?? null);
const loaded = ref(props.initialError === null || props.initialError === undefined);
const loading = ref(false);
const saving = ref(false);

const reload = async () => {
  loading.value = true;
  const { data, error: loadError } = await callApi<CodexUltraConfig>(
    () => api.api['codex-ultra-config'].$get(),
  );
  loading.value = false;
  if (loadError) {
    error.value = loadError.message;
    return;
  }
  draft.value = { ...data };
  loaded.value = true;
  error.value = null;
};

const save = async () => {
  if (!loaded.value) return;
  saving.value = true;
  const { data, error: saveError } = await callApi<CodexUltraConfig>(
    () => api.api['codex-ultra-config'].$put({ json: draft.value }),
  );
  saving.value = false;
  if (saveError) {
    error.value = saveError.message;
    return;
  }
  draft.value = { ...data };
  error.value = null;
};
</script>

<template>
  <div class="glass-card p-5 sm:p-6 animate-in delay-2">
    <div class="mb-4">
      <h3 class="mb-1 font-semibold text-white">Codex Ultra</h3>
      <p class="text-sm text-gray-400">Add Codex's proactive multi-agent mode to eligible GPT models in Floway's Codex catalog.</p>
    </div>

    <div v-if="error" role="alert" class="mb-4 flex items-center justify-between gap-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">
      <span>{{ error }}</span>
      <Button v-if="!loaded" variant="secondary" size="sm" :loading="loading" @click="reload">Retry</Button>
    </div>

    <div class="rounded-xl border border-violet-400/20 bg-violet-400/[0.06] p-4">
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-sm font-medium text-white">Enable Ultra support</p>
          <p class="mt-1 text-xs leading-relaxed text-gray-500">For Codex clients, Floway advertises Ultra only on GPT models that already support <code class="text-gray-300">max</code>. Codex enables proactive delegation locally and sends <code class="text-gray-300">max</code> on the wire.</p>
          <div class="mt-3 inline-flex items-center gap-2 rounded-lg border border-white/[0.06] bg-surface-900 px-3 py-2 font-mono text-xs">
            <span class="font-semibold text-violet-300">Ultra</span>
            <i class="i-lucide-arrow-right size-3.5 text-gray-600" />
            <span class="text-accent-cyan">max</span>
            <span class="font-sans text-gray-600">client-owned</span>
          </div>
        </div>
        <Switch v-model="draft.enabled" :disabled="!loaded" aria-label="Enable Codex Ultra support" />
      </div>
    </div>

    <div class="mt-5 flex items-center gap-3">
      <Button :loading="saving" :disabled="!loaded" @click="save">Save Ultra Config</Button>
      <p class="text-xs text-gray-600">Other models and existing effort values are not changed.</p>
    </div>
  </div>
</template>
