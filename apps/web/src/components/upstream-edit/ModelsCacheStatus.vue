<script setup lang="ts">
import { useNow } from '@vueuse/core';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { computed, ref } from 'vue';

import type { UpstreamRecord } from '../../api/types.ts';

dayjs.extend(relativeTime);

const props = defineProps<{
  modelsCache: UpstreamRecord['modelsCache'];
}>();

const now = useNow({ interval: 30_000 });
const fetchedLabel = computed(() => props.modelsCache.fetchedAt === null
  ? 'never'
  : dayjs(props.modelsCache.fetchedAt).from(now.value));
const errorAtLabel = computed(() => props.modelsCache.lastError === null
  ? null
  : dayjs(props.modelsCache.lastError.at).from(now.value));

const errorOpen = ref(false);
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
      <span class="text-gray-300">last fetched <span class="text-white">{{ fetchedLabel }}</span></span>
      <span
        v-if="modelsCache.lastError"
        class="cursor-pointer text-accent-rose hover:underline"
        @click="errorOpen = !errorOpen"
      >last error {{ errorAtLabel }} ({{ errorOpen ? 'hide' : 'show' }})</span>
    </div>
    <p
      v-if="modelsCache.lastError && errorOpen"
      class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 font-mono text-[11px] text-accent-rose"
    >{{ modelsCache.lastError.message }}</p>
  </div>
</template>
