<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';

import { type KeySource, KEY_SOURCE_OPTIONS } from './keySource.ts';
import RetentionField, { type RetentionFieldValue } from './RetentionField.vue';
import { callApi, useApi } from '../../api/client.ts';
import type { ApiKey } from '../../api/types.ts';
import type { UpstreamOption } from '../../composables/useUpstreamOptions.ts';
import { useAuthStore } from '../../stores/auth.ts';
import UpstreamPicker, { type UpstreamPickerValue } from '../upstreams/UpstreamPicker.vue';
import { Button, Dialog, Input, Select } from '@floway-dev/ui';

const open = defineModel<boolean>('open');

const props = defineProps<{ upstreams: UpstreamOption[] } & ({ mode: 'create' } | { mode: 'edit'; apiKey: ApiKey })>();

const emit = defineEmits<{ saved: [apiKey: ApiKey] }>();

const api = useApi();
const auth = useAuthStore();

const visibleUpstreams = computed<UpstreamOption[]>(() => {
  if (!auth.currentUser) throw new Error('EditKeyDialog rendered without an authenticated user');
  const cap = auth.currentUser.upstreamIds;
  if (cap === null) return props.upstreams;
  const allowed = new Set(cap);
  return props.upstreams.filter(u => allowed.has(u.id));
});

const dumpRetentionPresets = [
  { seconds: 3600, label: '1 hour' },
  { seconds: 6 * 3600, label: '6 hours' },
  { seconds: 24 * 3600, label: '24 hours' },
  { seconds: 7 * 86400, label: '7 days' },
] as const;

const responsesRetentionPresets = [
  { seconds: 7 * 86400, label: '7 days' },
  { seconds: 30 * 86400, label: '30 days' },
] as const;

const name = ref('');
const upstreamSelection = ref<UpstreamPickerValue>({ override: false, ids: [] });
const dumpRetention = ref<RetentionFieldValue>(null);
const responsesRetention = ref<RetentionFieldValue>(0);
const keySource = ref<KeySource>('generate');
const customKey = ref('');
const saving = ref(false);
const error = ref<string | null>(null);

const reset = () => {
  if (props.mode === 'create') {
    name.value = '';
    upstreamSelection.value = { override: false, ids: [] };
    dumpRetention.value = null;
    responsesRetention.value = 0;
    keySource.value = 'generate';
    customKey.value = '';
  } else {
    name.value = props.apiKey.name;
    upstreamSelection.value = {
      override: props.apiKey.upstream_ids !== null,
      ids: props.apiKey.upstream_ids ?? [],
    };
    dumpRetention.value = props.apiKey.dump_retention_seconds;
    responsesRetention.value = props.apiKey.responses_retention_seconds;
  }
  error.value = null;
};

watch(open, v => { if (v) reset(); }, { immediate: true });

const retentionEnabled = computed(() => {
  const proposed = dumpRetention.value;
  return proposed !== null && proposed !== 'invalid';
});

const retentionWarning = computed<string | null>(() => {
  if (props.mode === 'create') return null;
  const previous = props.apiKey.dump_retention_seconds;
  if (previous === null) return null;
  const next = dumpRetention.value;
  if (next === 'invalid') return null;
  if (next === null) return 'Saving will immediately delete dumps for this key.';
  if (next < previous) return 'Saving will immediately delete dumps older than the new window.';
  return null;
});

const responsesRetentionWarning = computed<string | null>(() => {
  if (props.mode === 'create') return null;
  const next = responsesRetention.value;
  if (typeof next !== 'number' || next >= props.apiKey.responses_retention_seconds) return null;
  if (next === 0) return 'Saving will immediately reset all durable Stateful Responses chains for this key.';
  return 'Saving will make state older than the new window unavailable; chains that depend on it will stop resolving.';
});

const save = async () => {
  const trimmed = name.value.trim();
  if (!trimmed) {
    error.value = 'Name is required';
    return;
  }
  if (upstreamSelection.value.override && upstreamSelection.value.ids.length === 0) {
    error.value = 'Select at least one upstream, or turn off the override to use every upstream available to you.';
    return;
  }
  const nextDumpRetention = dumpRetention.value;
  const nextResponsesRetention = responsesRetention.value;
  if (nextDumpRetention === 'invalid' || typeof nextResponsesRetention !== 'number') {
    error.value = 'Retention must be an integer number of seconds, or a value like 30m / 2h / 3d.';
    return;
  }
  const custom = customKey.value.trim();
  if (props.mode === 'create' && keySource.value === 'custom' && !custom) {
    error.value = 'Custom API key is required.';
    return;
  }

  saving.value = true;
  error.value = null;
  const commonBody = {
    name: trimmed,
    upstream_ids: upstreamSelection.value.override ? upstreamSelection.value.ids : null,
    dump_retention_seconds: nextDumpRetention,
    responses_retention_seconds: nextResponsesRetention,
  };
  const { data, error: err } = props.mode === 'create'
    ? await callApi<ApiKey>(() => api.api.keys.$post({
        json: {
          ...commonBody,
          key_source: keySource.value,
          ...(keySource.value === 'custom' ? { custom_key: custom } : {}),
        },
      }))
    : await callApi<ApiKey>(
        () => api.api.keys[':id'].$patch({ param: { id: props.apiKey.id }, json: commonBody }),
      );
  saving.value = false;
  if (err) {
    error.value = err.message;
    return;
  }
  if (!data) throw new Error('API key save succeeded without returning the saved key');
  open.value = false;
  emit('saved', data);
};
</script>

<template>
  <Dialog v-model:open="open" :title="mode === 'create' ? 'Create API Key' : 'Edit API Key'" size="lg" :auto-focus-on-open="false">
    <div class="space-y-5">
      <div class="space-y-2">
        <label class="block text-xs font-medium text-gray-500">Name</label>
        <Input v-model="name" />
      </div>

      <UpstreamPicker
        v-model="upstreamSelection"
        :available="visibleUpstreams"
        title="Override Available Upstreams"
        inherit-description="When off, this key inherits the global upstream order."
      />

      <div v-if="mode === 'create'" class="space-y-2">
        <label class="block text-xs font-medium text-gray-500">New key</label>
        <Select v-model="keySource" :options="KEY_SOURCE_OPTIONS">
          <template #description="{ option }">
            <span class="text-xs text-gray-500">{{ option.description }}</span>
          </template>
        </Select>
        <Input
          v-if="keySource === 'custom'"
          v-model="customKey"
          placeholder="Paste custom API key"
        />
      </div>

      <RetentionField
        v-model="dumpRetention"
        label="Request dump retention"
        description="When enabled, every model-invoking request through this key is recorded for the configured window. Off means no capture."
        :off-value="null"
        off-label="Off (do not capture)"
        :presets="dumpRetentionPresets"
      >
        <p v-if="retentionWarning" role="status" aria-live="polite" class="rounded-md border border-accent-amber/40 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber">
          {{ retentionWarning }}
        </p>
        <p v-if="props.mode === 'edit' && retentionEnabled" class="text-xs text-gray-500">
          <RouterLink :to="`/dashboard/requests/${props.apiKey.id}`" class="text-accent-cyan hover:underline">
            View captured requests →
          </RouterLink>
        </p>
      </RetentionField>

      <RetentionField
        v-model="responsesRetention"
        label="Stateful Responses retention"
        description="Controls durable Responses items and previous_response_id chains for this key. Off keeps HTTP stateless; WebSocket session-local state remains available."
        :off-value="0"
        off-label="Off (no durable state)"
        :presets="responsesRetentionPresets"
        :minimum-seconds="3600"
      >
        <p v-if="responsesRetentionWarning" role="status" aria-live="polite" class="rounded-md border border-accent-amber/40 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber">
          {{ responsesRetentionWarning }}
        </p>
      </RetentionField>

      <p v-if="error" class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">{{ error }}</p>

      <footer class="flex items-center justify-end gap-2">
        <Button variant="secondary" :disabled="saving" @click="open = false">Cancel</Button>
        <Button :loading="saving" @click="save">
          {{ mode === 'create' ? 'Create key' : 'Save changes' }}
        </Button>
      </footer>
    </div>
  </Dialog>
</template>
