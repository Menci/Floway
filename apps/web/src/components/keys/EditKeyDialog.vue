<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';

import { type KeySource, KEY_SOURCE_OPTIONS } from './keySource.ts';
import { callApi, useApi } from '../../api/client.ts';
import type { ApiKey } from '../../api/types.ts';
import type { UpstreamOption } from '../../composables/useUpstreamOptions.ts';
import { useAuthStore } from '../../stores/auth.ts';
import { parseDuration } from '../../utils/parseDuration.ts';
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

type RetentionPreset = 'off' | '1h' | '6h' | '24h' | '7d' | 'custom';

const retentionPresetSeconds: Record<Exclude<RetentionPreset, 'off' | 'custom'>, number> = {
  '1h': 3600,
  '6h': 6 * 3600,
  '24h': 24 * 3600,
  '7d': 7 * 86400,
};

const retentionOptions: { value: RetentionPreset; label: string }[] = [
  { value: 'off', label: 'Off (do not capture)' },
  { value: '1h', label: '1 hour' },
  { value: '6h', label: '6 hours' },
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: 'custom', label: 'Custom…' },
];

const retentionPresetFromValue = (sec: number | null): { preset: RetentionPreset; custom: string } => {
  if (sec === null) return { preset: 'off', custom: '' };
  for (const [preset, value] of Object.entries(retentionPresetSeconds)) {
    if (value === sec) return { preset: preset as RetentionPreset, custom: '' };
  }
  if (sec % 86400 === 0) return { preset: 'custom', custom: `${sec / 86400}d` };
  if (sec % 3600 === 0) return { preset: 'custom', custom: `${sec / 3600}h` };
  if (sec % 60 === 0) return { preset: 'custom', custom: `${sec / 60}m` };
  // Emit an explicit 's' suffix so raw seconds don't collide with the
  // mixed-unit placeholder shown in the custom retention Input.
  return { preset: 'custom', custom: `${sec}s` };
};

const name = ref('');
const upstreamSelection = ref<UpstreamPickerValue>({ override: false, ids: [] });
const retentionPreset = ref<RetentionPreset>('off');
const retentionCustom = ref('');
const keySource = ref<KeySource>('generate');
const customKey = ref('');
const saving = ref(false);
const error = ref<string | null>(null);

const reset = () => {
  if (props.mode === 'create') {
    name.value = '';
    upstreamSelection.value = { override: false, ids: [] };
    retentionPreset.value = 'off';
    retentionCustom.value = '';
    keySource.value = 'generate';
    customKey.value = '';
  } else {
    name.value = props.apiKey.name;
    upstreamSelection.value = {
      override: props.apiKey.upstream_ids !== null,
      ids: props.apiKey.upstream_ids ?? [],
    };
    const { preset, custom } = retentionPresetFromValue(props.apiKey.dump_retention_seconds);
    retentionPreset.value = preset;
    retentionCustom.value = custom;
  }
  error.value = null;
};

watch(open, v => { if (v) reset(); }, { immediate: true });

const proposedRetentionSeconds = computed<number | null | 'invalid'>(() => {
  if (retentionPreset.value === 'off') return null;
  if (retentionPreset.value === 'custom') {
    return parseDuration(retentionCustom.value) ?? 'invalid';
  }
  return retentionPresetSeconds[retentionPreset.value];
});

const retentionEnabled = computed(() => {
  const proposed = proposedRetentionSeconds.value;
  return proposed !== null && proposed !== 'invalid';
});

const retentionWarning = computed<string | null>(() => {
  if (props.mode === 'create') return null;
  const previous = props.apiKey.dump_retention_seconds;
  if (previous === null) return null;
  const next = proposedRetentionSeconds.value;
  if (next === 'invalid') return null;
  if (next === null) return 'Saving will immediately delete dumps for this key.';
  if (next < previous) return 'Saving will immediately delete dumps older than the new window.';
  return null;
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
  const proposedRetention = proposedRetentionSeconds.value;
  if (proposedRetention === 'invalid') {
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
    dump_retention_seconds: proposedRetention,
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

      <div class="space-y-2">
        <label class="block text-xs font-medium text-gray-500">Request dump retention</label>
        <p class="text-xs text-gray-600">
          When enabled, every model-invoking request through this key is recorded for the
          configured window. Off means no capture.
        </p>
        <Select v-model="retentionPreset" :options="retentionOptions" />
        <Input
          v-if="retentionPreset === 'custom'"
          v-model="retentionCustom"
          placeholder="e.g. 30m, 2h, 3d, 1800"
        />
        <p v-if="retentionWarning" class="rounded-md border border-accent-amber/40 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber">
          {{ retentionWarning }}
        </p>
        <p v-if="props.mode === 'edit' && retentionEnabled" class="text-xs text-gray-500">
          <RouterLink :to="`/dashboard/requests/${props.apiKey.id}`" class="text-accent-cyan hover:underline">
            View captured requests →
          </RouterLink>
        </p>
      </div>

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
