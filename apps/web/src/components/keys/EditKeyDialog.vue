<script setup lang="ts">
import { Badge, Button, Dialog, Input, Sortable, Spinner, Switch } from '@floway-dev/ui';
import { computed, ref, watch } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { ApiKey, UpstreamProviderKind, UpstreamRecord } from '../../api/types.ts';

const open = defineModel<boolean>('open');

const props = defineProps<{
  apiKey?: ApiKey;
  upstreams: UpstreamRecord[];
}>();

const emit = defineEmits<{ saved: [] }>();

const api = useApi();

interface RowState {
  id: string;
  name: string;
  provider: UpstreamProviderKind | null;
  enabled: boolean;
}

const name = ref('');
const override = ref(false);
const rows = ref<RowState[]>([]);
const saving = ref(false);
const error = ref<string | null>(null);

const reset = () => {
  if (!props.apiKey) return;
  name.value = props.apiKey.name;
  override.value = props.apiKey.upstream_ids !== null;
  const orderedIds = props.apiKey.upstream_ids ?? [];
  const orderedSet = new Set(orderedIds);
  // Order: existing selection first (preserve order), then the rest by their global sort_order.
  const rest = props.upstreams.filter(u => !orderedSet.has(u.id));
  rows.value = [
    ...orderedIds.map(id => {
      const u = props.upstreams.find(x => x.id === id);
      return { id, name: u?.name ?? `Unknown (${id})`, provider: u?.provider ?? null, enabled: true };
    }),
    ...rest.map(u => ({ id: u.id, name: u.name, provider: u.provider, enabled: false })),
  ];
  error.value = null;
};

watch(open, v => { if (v) reset(); });

const save = async () => {
  if (!props.apiKey) return;
  const trimmed = name.value.trim();
  if (!trimmed) {
    error.value = 'Name is required';
    return;
  }
  saving.value = true;
  error.value = null;
  const body = {
    name: trimmed,
    upstream_ids: override.value ? rows.value.filter(r => r.enabled).map(r => r.id) : null,
  };
  const { error: err } = await callApi(
    () => api.api.keys[':id'].$patch({ param: { id: props.apiKey!.id }, json: body }),
  );
  saving.value = false;
  if (err) {
    error.value = err.message;
    return;
  }
  open.value = false;
  emit('saved');
};

const titleText = 'Edit API Key';

const enabledCount = computed(() => rows.value.filter(r => r.enabled).length);
const overrideBadgeCount = computed(() => override.value ? enabledCount.value : props.upstreams.length);

const providerTone = (provider: UpstreamProviderKind | null): 'amber' | 'emerald' | 'cyan' | 'zinc' => {
  if (provider === 'custom') return 'amber';
  if (provider === 'azure') return 'emerald';
  if (provider === 'copilot') return 'cyan';
  return 'zinc';
};

const providerLabel = (provider: UpstreamProviderKind | null) => {
  if (provider === 'custom') return 'Custom';
  if (provider === 'azure') return 'Azure';
  if (provider === 'copilot') return 'Copilot';
  return 'Unknown';
};
</script>

<template>
  <Dialog v-model:open="open" :title="titleText" size="lg" :auto-focus-on-open="false">
    <div class="space-y-5">
      <div class="space-y-2">
        <label class="block text-xs font-medium text-gray-500">Name</label>
        <Input v-model="name" />
      </div>

      <div class="space-y-3">
        <label class="flex items-center justify-between rounded-md border border-white/[0.06] bg-surface-800/40 px-3 py-2.5">
          <span>
            <p class="text-sm text-white">
              Override Available Upstreams
              <span class="ml-1.5 font-mono text-[10px] font-medium text-accent-cyan">({{ overrideBadgeCount }})</span>
            </p>
            <p class="text-xs text-gray-500">When off, this key inherits the global upstream order.</p>
          </span>
          <Switch v-model="override" />
        </label>

        <Sortable
          v-if="override"
          v-model="rows"
          :item-key="r => r.id"
          handle=".floway-drag-handle"
          tag="ul"
          class="space-y-1.5"
        >
          <template #default="{ item: row }">
            <li :key="row.id" class="flex items-center gap-3 rounded-md border border-white/[0.06] bg-surface-800/40 px-3 py-2">
              <button
                type="button"
                class="floway-drag-handle grid size-6 cursor-grab place-items-center rounded text-gray-500 hover:bg-surface-700 hover:text-gray-200 active:cursor-grabbing"
                aria-label="Drag to reorder"
              >
                <i class="i-lucide-grip-vertical size-4" />
              </button>
              <Switch :model-value="row.enabled" @update:model-value="v => row.enabled = !!v" />
              <Badge :tone="providerTone(row.provider)" size="sm" class="shrink-0 !rounded !uppercase tracking-wide">{{ providerLabel(row.provider) }}</Badge>
              <span class="min-w-0 flex-1 truncate text-sm text-white">{{ row.name }}</span>
              <code class="text-xs text-gray-500">{{ row.id }}</code>
            </li>
          </template>
        </Sortable>
      </div>

      <p v-if="error" class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">{{ error }}</p>

      <footer class="flex items-center justify-end gap-2">
        <Button variant="secondary" :disabled="saving" @click="open = false">Cancel</Button>
        <Button :loading="saving" @click="save">
          <Spinner v-if="saving" class="size-3.5" />
          Save changes
        </Button>
      </footer>
    </div>
  </Dialog>
</template>
