<script setup lang="ts">
import { computed } from 'vue';

import type { RerankProtocol, RerankTarget } from '@floway-dev/protocols/common';
import { DEFAULT_RERANK_PATHS } from '@floway-dev/protocols/rerank';
import { Input, Select } from '@floway-dev/ui';

const target = defineModel<RerankTarget>({ required: true });

defineProps<{
  disabled?: boolean;
}>();

const protocolOptions: { value: RerankProtocol; label: string }[] = [
  { value: 'cohere-v1', label: 'Cohere v1' },
  { value: 'cohere-v2', label: 'Cohere v2' },
  { value: 'jina-v1', label: 'Jina v1' },
  { value: 'voyage-v1', label: 'Voyage v1' },
  { value: 'dashscope-compatible', label: 'DashScope compatible' },
  { value: 'dashscope-native', label: 'DashScope native' },
];

const pathPlaceholder = computed(() => DEFAULT_RERANK_PATHS[target.value.protocol]);

const setProtocol = (protocol: RerankProtocol) => {
  target.value = { ...target.value, protocol };
};

const setPath = (path: string) => {
  const trimmed = path.trim();
  target.value = trimmed === ''
    ? { protocol: target.value.protocol }
    : { ...target.value, path: trimmed };
};
</script>

<template>
  <section>
    <div class="mb-3 flex items-baseline gap-3">
      <h3 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Rerank Target</h3>
      <span class="text-[11px] text-gray-500">the request dialect and model-specific upstream path</span>
    </div>
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="block space-y-1.5">
        <span class="block text-xs font-medium text-gray-500">Protocol</span>
        <Select
          :model-value="target.protocol"
          :options="protocolOptions"
          :disabled="disabled"
          @update:model-value="value => setProtocol(value as RerankProtocol)"
        />
      </label>
      <label class="block space-y-1.5">
        <span class="block text-xs font-medium text-gray-500">Path override</span>
        <Input
          :model-value="target.path"
          :disabled="disabled"
          :placeholder="pathPlaceholder"
          class="font-mono"
          @update:model-value="setPath"
        />
      </label>
    </div>
  </section>
</template>
