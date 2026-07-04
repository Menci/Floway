<script setup lang="ts">
import { useNow } from '@vueuse/core';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { computed, onBeforeUnmount, useTemplateRef, watch } from 'vue';

import { errorLabel, rowTintClass, statusIcon } from './badge.ts';
import type { DumpMetadata } from '@floway-dev/gateway/dump-types';
import { OverlayScrollbars, Spinner } from '@floway-dev/ui';

dayjs.extend(relativeTime);

const props = defineProps<{
  records: DumpMetadata[];
  loading: boolean;
  error: string | null;
}>();

const selectedId = defineModel<string | null>('selectedId');

const emit = defineEmits<{ loadOlder: [] }>();

const sentinelRef = useTemplateRef<HTMLDivElement>('sentinel');

// The sentinel is gated by the loading/empty branches, so attach via watch
// rather than onMounted — a slow first load still arms infinite scroll once
// the scroll shell finally appears.
let observer: IntersectionObserver | null = null;

watch(sentinelRef, el => {
  observer?.disconnect();
  observer = null;
  if (!el) return;
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) emit('loadOlder');
    }
  }, { rootMargin: '200px' });
  observer.observe(el);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  // Drop the decimal once the value is round-ish (>= 10 in each unit) so the row
  // doesn't carry a trailing `.0`.
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  // Keep one decimal in the 1–60s band where the extra significant figure is
  // most actionable.
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
};

const formatTokens = (n: number): string => {
  if (n < 1000) return n.toString();
  // Space + uppercase ` K` matches the row's `ms` / `B` / `KB` neighbors; drop
  // the decimal at 10 K for the same reason as formatBytes.
  if (n < 10_000) return `${(n / 1000).toFixed(1)} K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} K`;
  return `${(n / 1_000_000).toFixed(1)} M`;
};

const upstreamKindTextClass = (kind: string): string => {
  switch (kind) {
  case 'copilot': return 'text-accent-cyan';
  case 'codex': return 'text-accent-violet';
  case 'azure': return 'text-accent-emerald';
  case 'custom': return 'text-accent-amber';
  case 'ollama': return 'text-accent-rose';
  case 'cursor': return 'text-accent-violet';
  default: return 'text-gray-500';
  }
};

// `inputTokens` / `outputTokens` are null when the upstream didn't report
// that dimension. Collapsing both to 0 would conflate "not measured" with
// "zero tokens".
const totalTokens = (meta: DumpMetadata): number | null => {
  if (meta.inputTokens === null && meta.outputTokens === null) return null;
  return (meta.inputTokens ?? 0) + (meta.outputTokens ?? 0);
};

// Wall-clock tick that drives the "X minutes ago" label so an idle list
// still re-renders past timestamps as time advances. Without it, the
// `dayjs().fromNow()` value is captured at first render and never refreshes
// until some other reactive trigger forces a redraw.
const now = useNow({ interval: 30_000 });
const relTime = (ms: number): string => {
  void now.value;
  return dayjs(ms).fromNow();
};
const fullTime = (ms: number): string => dayjs(ms).format('YYYY-MM-DD HH:mm:ss');

const selectRow = (id: string) => { selectedId.value = id; };

const rovingTabIndex = (record: DumpMetadata, position: number): 0 | -1 => {
  if (selectedId.value === record.id) return 0;
  if (selectedId.value === null && position === 0) return 0;
  return -1;
};

const moveSelection = (event: KeyboardEvent, delta: 1 | -1): void => {
  const current = event.currentTarget as HTMLElement;
  const sibling = (delta === 1 ? current.nextElementSibling : current.previousElementSibling) as HTMLElement | null;
  if (!sibling) return;
  sibling.focus();
  selectedId.value = sibling.dataset.recordId!;
};

const showEmpty = computed(() => !props.loading && props.records.length === 0 && props.error === null);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div v-if="error" class="m-2 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">
      {{ error }}
    </div>

    <div v-if="loading && records.length === 0" class="flex items-center justify-center gap-2 py-8 text-xs text-gray-500">
      <Spinner class="size-3.5" />
      Loading…
    </div>

    <div v-else-if="showEmpty" class="px-4 py-8 text-center text-xs text-gray-500">
      No requests recorded yet.
    </div>

    <OverlayScrollbars v-else class="min-h-0 flex-1">
      <ul class="divide-y divide-white/[0.03]" role="listbox" aria-label="Captured requests">
        <li
          v-for="(record, position) in records"
          :key="record.id"
          :tabindex="rovingTabIndex(record, position)"
          role="option"
          :aria-selected="selectedId === record.id"
          :data-record-id="record.id"
          class="cursor-pointer px-3 py-2.5 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-accent-cyan/60"
          :class="rowTintClass(record.status, record.error, selectedId === record.id)"
          @click="selectRow(record.id)"
          @keydown.enter.prevent="selectRow(record.id)"
          @keydown.space.prevent="selectRow(record.id)"
          @keydown.up.prevent="moveSelection($event, -1)"
          @keydown.down.prevent="moveSelection($event, 1)"
        >
          <div class="flex items-center gap-2 text-xs">
            <i
              :class="`${statusIcon(record.status, record.error).iconClass} ${statusIcon(record.status, record.error).colorClass} size-3.5`"
              :title="statusIcon(record.status, record.error).tooltip"
            />
            <span
              class="min-w-0 truncate text-gray-300"
              :class="record.model ? 'font-mono' : ''"
            >
              {{ record.model ?? 'Unknown' }}
            </span>
            <span class="ml-auto shrink-0 text-[11px] text-gray-500" :title="fullTime(record.startedAt)">
              {{ relTime(record.startedAt) }}
            </span>
          </div>

          <div class="mt-1 flex items-center gap-3 text-[11px]">
            <span class="min-w-0 flex-1 truncate font-mono text-gray-500" :title="`${record.method} ${record.path}`">
              {{ record.path }}
            </span>
            <span class="flex shrink-0 items-center gap-2.5 text-gray-500">
              <span class="inline-flex items-center gap-0.5" :title="`Duration ${record.durationMs}ms`">
                <i class="i-lucide-timer size-3" />
                {{ formatDuration(record.durationMs) }}
              </span>
              <span class="inline-flex items-center gap-0.5" :title="`Request body ${record.requestBytes} bytes`">
                <i class="i-lucide-arrow-up size-3" />
                {{ formatBytes(record.requestBytes) }}
              </span>
              <span class="inline-flex items-center gap-0.5" :title="`Response body ${record.responseBytes} bytes`">
                <i class="i-lucide-arrow-down size-3" />
                {{ formatBytes(record.responseBytes) }}
              </span>
            </span>
          </div>

          <div class="mt-1 flex items-center gap-2 text-[11px]">
            <span
              v-if="record.upstream"
              :class="upstreamKindTextClass(record.upstream.kind)"
              class="min-w-0 truncate"
              :title="`${record.upstream.kind} · ${record.upstream.id}`"
            >
              {{ record.upstream.name }}
            </span>
            <span
              v-if="errorLabel(record.error, record.status)"
              class="ml-auto min-w-0 truncate text-accent-rose"
              :title="errorLabel(record.error, record.status) ?? undefined"
            >
              {{ errorLabel(record.error, record.status) }}
            </span>
            <span v-else class="ml-auto shrink-0 text-gray-600">
              {{ totalTokens(record) === null ? '—' : `${formatTokens(totalTokens(record)!)} tok` }}
            </span>
          </div>
        </li>
      </ul>
      <div ref="sentinel" class="h-px w-full" aria-hidden="true" />
    </OverlayScrollbars>
  </div>
</template>
