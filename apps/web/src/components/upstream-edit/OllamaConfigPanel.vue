<script setup lang="ts">
// Ollama provider-specific fields: a base URL (default ollama.com) and an
// optional bearer token. The catalog is always live-fetched from /api/tags +
// /api/show — no toggle, no path overrides, no auth-style choice. The
// model-overrides list lives in a separate panel.

import type { OllamaDraft } from './customConfig.ts';
import SecretInput from '../shared/SecretInput.vue';
import { Button, Input } from '@floway-dev/ui';

const draft = defineModel<OllamaDraft>({ required: true });

defineProps<{
  apiKeySet: boolean;
  editMode: boolean;
  fetchLoading: boolean;
  fetchError: string | null;
  /** Wall-clock summary of the last fetch, e.g. "35 returned · 1m ago". */
  fetchStatus: string | null;
}>();

const emit = defineEmits<{ 'fetch-models': [] }>();
</script>

<template>
  <div class="space-y-5">
    <div>
      <label class="mb-1.5 block text-xs font-medium text-gray-500">Base URL</label>
      <Input
        :model-value="draft.baseUrl"
        placeholder="https://ollama.com"
        class="font-mono"
        @update:model-value="v => draft = { ...draft, baseUrl: v }"
      />
      <p class="mt-1.5 text-[11px] text-gray-600">
        Defaults to <code class="font-mono">https://ollama.com</code>. Point at a self-hosted Ollama daemon (e.g. <code class="font-mono">http://127.0.0.1:11434</code>) to use local models.
      </p>
    </div>

    <div>
      <label class="mb-1.5 block text-xs font-medium text-gray-500">
        API Key<span v-if="editMode && apiKeySet" class="text-gray-500"> (leave blank to keep)</span>
      </label>
      <SecretInput
        :model-value="draft.apiKey"
        :placeholder="apiKeySet ? '••••••••' : 'paste from ollama.com/settings/keys'"
        class="font-mono"
        @update:model-value="v => draft = { ...draft, apiKey: v }"
      />
      <p class="mt-1.5 text-[11px] text-gray-600">
        Required for <code class="font-mono">ollama.com</code>; optional for an unauthenticated local daemon. Sent as <code class="font-mono">Authorization: Bearer &lt;key&gt;</code> when set.
      </p>
    </div>

    <div>
      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p class="text-xs font-medium text-gray-500">Fetch models</p>
        <div class="flex items-center gap-3">
          <p v-if="fetchStatus" class="text-[11px] text-gray-500">{{ fetchStatus }}</p>
          <Button
            variant="secondary"
            size="sm"
            :loading="fetchLoading"
            :disabled="fetchLoading"
            @click="emit('fetch-models')"
          >Fetch</Button>
        </div>
      </div>
      <!-- Live `last fetched / last error` snapshot injected by the parent —
           rendered immediately under the button row so the outcome reads as
           the button's result row (any transient fetch error below sits as a
           footnote, not between button and result). -->
      <div v-if="$slots['cache-status']" class="mt-1.5">
        <slot name="cache-status" />
      </div>
      <p v-if="fetchError" class="mt-1.5 text-[11px] text-accent-rose">{{ fetchError }}</p>
    </div>
  </div>
</template>
