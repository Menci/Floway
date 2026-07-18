<script setup lang="ts">
// Custom provider-specific fields (Base URL, auth, default endpoints, fetch
// /models toggle, path overrides). The model list is owned by a separate
// panel — this panel only carries the connection-shaped config.

import type { CustomAuthStyle, CustomDraft } from './customConfig.ts';
import { PATH_KEYS } from './customConfig.ts';
import EndpointsField from './EndpointsField.vue';
import SecretInput from '../shared/SecretInput.vue';
import { Button, Input, Select, Switch } from '@floway-dev/ui';

const draft = defineModel<CustomDraft>({ required: true });

defineProps<{
  apiKeySet: boolean;
  editMode: boolean;
  fetchLoading: boolean;
  fetchError: string | null;
  /** Wall-clock summary of the last fetch, e.g. "12 returned · 3m ago". */
  fetchStatus: string | null;
}>();

const emit = defineEmits<{ 'fetch-models': [] }>();

// Auth styles are presented as a dropdown rather than a radio grid because
// the radio cards crowded the panel even at two options and would have run
// out of space at three. The dropdown also carries a per-option description
// slot, which lets the actual HTTP header live next to the human label
// inside the popover rather than as a permanently-visible block.
interface AuthOption {
  value: CustomAuthStyle;
  label: string;
  explanation: string;
  headerExample?: string;
}

const authOptions: AuthOption[] = [
  {
    value: 'bearer',
    label: 'Bearer',
    explanation: 'Most OpenAI-compatible APIs. Sends the key in the Authorization header.',
    headerExample: 'Authorization: Bearer <key>',
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    explanation: 'Anthropic-compatible APIs. Sends the key in a custom header plus an API version.',
    headerExample: 'x-api-key: <key>\nanthropic-version: 2023-06-01',
  },
  {
    value: 'none',
    label: 'None',
    explanation: 'No authentication. Use for local or internal upstreams that accept anonymous requests.',
  },
];

const setAuthStyle = (style: CustomAuthStyle) => {
  // Switching to 'none' strips any in-flight apiKey; switching away leaves
  // the field blank so the user explicitly re-enters it.
  draft.value = style === 'none'
    ? { ...draft.value, authStyle: 'none', apiKey: '' }
    : { ...draft.value, authStyle: style };
};
</script>

<template>
  <div class="space-y-5">
    <div>
      <label class="mb-1.5 block text-xs font-medium text-gray-500">Base URL</label>
      <Input
        :model-value="draft.baseUrl"
        placeholder="e.g. https://api.openai.com"
        class="font-mono"
        @update:model-value="v => draft = { ...draft, baseUrl: v }"
      />
    </div>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <label class="mb-1.5 block text-xs font-medium text-gray-500">Auth Style</label>
        <Select
          :model-value="draft.authStyle"
          :options="authOptions"
          @update:model-value="v => v !== undefined && setAuthStyle(v)"
        >
          <template #description="{ option }">
            <p class="text-[11px] text-gray-500">{{ option.explanation }}</p>
            <code v-if="option.headerExample" class="mt-1 block whitespace-pre font-mono text-[10px] text-gray-600">{{ option.headerExample }}</code>
          </template>
        </Select>
      </div>
      <div v-if="draft.authStyle !== 'none'">
        <label class="mb-1.5 block text-xs font-medium text-gray-500">
          API Key<span v-if="editMode && apiKeySet" class="text-gray-500"> (leave blank to keep)</span>
        </label>
        <SecretInput
          :model-value="draft.apiKey"
          :placeholder="apiKeySet ? '••••••••' : (draft.authStyle === 'anthropic' ? 'sk-ant-xxxxx' : 'sk-xxxxx')"
          class="font-mono"
          @update:model-value="v => draft = { ...draft, apiKey: v }"
        />
      </div>
    </div>

    <div>
      <p class="mb-2 text-xs font-medium text-gray-500">Default LLM Endpoints</p>
      <EndpointsField
        :model-value="draft.endpoints"
        kind="chat"
        @update:model-value="v => draft = { ...draft, endpoints: v }"
      />
      <p class="mt-1.5 text-[11px] text-gray-600">Chat models auto-discovered from <code class="font-mono">/models</code> inherit this set; manual rows pick their own.</p>
    </div>

    <div>
      <div class="mb-2 flex items-baseline justify-between gap-3">
        <p class="text-xs font-medium text-gray-500">Fetch <code class="font-mono">/models</code></p>
        <p v-if="fetchStatus" class="text-[11px] text-gray-500">{{ fetchStatus }}</p>
      </div>
      <div class="flex items-center gap-2">
        <Switch
          :model-value="draft.modelsFetch.enabled"
          @update:model-value="v => draft = { ...draft, modelsFetch: { ...draft.modelsFetch, enabled: !!v } }"
        />
        <Input
          :model-value="draft.modelsFetch.endpoint"
          placeholder="/v1/models (default)"
          size="sm"
          class="flex-1 font-mono"
          :class="!draft.modelsFetch.enabled && 'pointer-events-none opacity-50'"
          @update:model-value="v => draft = { ...draft, modelsFetch: { ...draft.modelsFetch, endpoint: v } }"
        />
        <Button
          variant="secondary"
          size="sm"
          :loading="fetchLoading"
          :disabled="!draft.modelsFetch.enabled || fetchLoading"
          @click="emit('fetch-models')"
        >Fetch</Button>
      </div>
      <!-- Live `last fetched / last error` snapshot injected by the parent —
           rendered immediately under the button row so the outcome reads as
           the button's result row (transient fetch error / disabled warning
           below sit as a footnote, not between button and result). -->
      <div v-if="$slots['cache-status']" class="mt-1.5">
        <slot name="cache-status" />
      </div>
      <p v-if="fetchError" class="mt-1.5 text-[11px] text-accent-rose">{{ fetchError }}</p>
      <p v-else-if="!draft.modelsFetch.enabled" class="mt-1.5 text-[11px] text-accent-amber">
        Fetch disabled — auto models are hidden and dropped on save. Only manual rows persist.
      </p>
    </div>

    <div>
      <p class="mb-2 text-xs font-medium text-gray-500">Path Overrides</p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label v-for="key in PATH_KEYS" :key="key" class="min-w-0">
          <span class="mb-1 block truncate font-mono text-[10px] text-gray-500">{{ key }}</span>
          <Input
            :model-value="draft.pathOverrides[key]"
            :placeholder="`/v1${key}`"
            size="sm"
            class="font-mono"
            @update:model-value="v => draft = { ...draft, pathOverrides: { ...draft.pathOverrides, [key]: v } }"
          />
        </label>
      </div>
      <p class="mt-2 text-[11px] text-gray-600">
        Leave blank to use the default <code class="font-mono">/v1/&lt;endpoint&gt;</code>. Count-tokens follows the messages path.
      </p>
    </div>
  </div>
</template>
