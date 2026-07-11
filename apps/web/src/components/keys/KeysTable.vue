<script setup lang="ts">
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { computed } from 'vue';

import type { ApiKey } from '../../api/types.ts';
import type { UpstreamOption } from '../../composables/useUpstreamOptions.ts';
import { OverlayScrollbars } from '@floway-dev/ui';

dayjs.extend(relativeTime);

const props = defineProps<{
  keys: ApiKey[];
  upstreams: UpstreamOption[];
  selectedId: string;
  copied: string | null;
  copyFailed: string | null;
}>();

defineEmits<{
  select: [id: string];
  copy: [text: string, tag: string];
  edit: [key: ApiKey];
  rotate: [key: ApiKey];
  remove: [key: ApiKey];
}>();

const upstreamById = computed(() => {
  const map = new Map<string, UpstreamOption>();
  for (const u of props.upstreams) map.set(u.id, u);
  return map;
});

const truncateKey = (k: string) => k.length <= 12 ? k : `${k.slice(0, 6)}…${k.slice(-4)}`;
const shortDate = (s: string | null | undefined) => s ? dayjs(s).format('MMM D, YYYY') : '';
const timeAgo = (s: string | null | undefined) => s ? dayjs(s).fromNow() : '';
const fullDateTime = (s: string | null | undefined) => s ? dayjs(s).format('YYYY-MM-DD HH:mm:ss') : '';

const upstreamsText = (k: ApiKey) => {
  if (!k.upstream_ids) return 'All';
  if (k.upstream_ids.length === 0) return 'None';
  const names = k.upstream_ids.map(id => upstreamById.value.get(id)?.name).filter((n): n is string => !!n);
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
};

const upstreamsTitle = (k: ApiKey) => {
  if (!k.upstream_ids) return 'Inherits the global upstream order';
  if (k.upstream_ids.length === 0) return 'No upstreams';
  return k.upstream_ids.map(id => upstreamById.value.get(id)?.name ?? id).join('\n');
};

const upstreamsTextClass = (k: ApiKey) => {
  if (!k.upstream_ids) return 'text-gray-500';
  if (k.upstream_ids.length === 0) return 'text-accent-rose';
  return 'text-accent-cyan';
};
</script>

<template>
  <OverlayScrollbars>
    <p v-if="keys.length === 0" class="text-sm text-gray-500 py-4 text-center">
      No API keys yet. Create one above.
    </p>

    <table v-else class="w-full min-w-[860px] text-sm">
      <thead>
        <tr class="border-b border-white/5">
          <th class="text-left py-2 pr-4 pl-7 text-xs font-medium text-gray-500 uppercase tracking-widest">Name</th>
          <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Key</th>
          <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Upstreams</th>
          <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Created</th>
          <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Last Used</th>
          <th class="text-right py-2 pr-2 text-xs font-medium text-gray-500 uppercase tracking-widest">Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="k in keys"
          :key="k.id"
          class="border-b border-white/[0.03] transition-colors cursor-pointer"
          :class="selectedId === k.id ? 'bg-accent-cyan/5 hover:bg-accent-cyan/8' : 'hover:bg-white/[0.02]'"
          @click="$emit('select', k.id)"
        >
          <td class="py-3 pr-4 pl-2">
            <div class="flex items-center gap-2 min-w-0">
              <div
                class="w-1.5 h-1.5 rounded-full shrink-0 transition-colors"
                :class="selectedId === k.id ? 'bg-accent-cyan' : 'bg-transparent'"
              />
              <span class="text-white font-medium truncate">{{ k.name }}</span>
            </div>
          </td>
          <td class="py-3 pr-4">
            <code class="text-xs font-mono text-gray-500 bg-surface-800 rounded px-2 py-1">{{ truncateKey(k.key) }}</code>
          </td>
          <td class="py-3 pr-4">
            <span class="text-xs cursor-default" :class="upstreamsTextClass(k)" :title="upstreamsTitle(k)">
              {{ upstreamsText(k) }}
            </span>
          </td>
          <td class="py-3 pr-4">
            <span class="text-gray-500 text-xs cursor-default" :title="fullDateTime(k.created_at)">{{ shortDate(k.created_at) }}</span>
          </td>
          <td class="py-3 pr-4">
            <span v-if="k.last_used_at" class="text-gray-500 text-xs cursor-default" :title="fullDateTime(k.last_used_at)">{{ timeAgo(k.last_used_at) }}</span>
            <span v-else class="text-gray-600 text-xs">Never</span>
          </td>
          <td class="py-3 pr-2 text-right">
            <div class="flex items-center justify-end gap-1">
              <button
                class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md hover:bg-white/[0.04] transition-colors p-1"
                :class="copyFailed === 'key-' + k.id ? 'text-accent-rose' : 'text-gray-600 hover:text-accent-cyan'"
                aria-label="Copy API key"
                :title="copyFailed === 'key-' + k.id ? 'Copy failed' : 'Copy key'"
                @click.stop="$emit('copy', k.key, 'key-' + k.id)"
              >
                <svg v-if="copyFailed === 'key-' + k.id" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
                <svg v-else-if="copied !== 'key-' + k.id" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <svg v-else class="w-4 h-4 text-accent-emerald" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </button>
              <button
                class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-gray-600 hover:text-accent-cyan hover:bg-white/[0.04] transition-colors p-1"
                aria-label="Edit API key"
                title="Edit key"
                @click.stop="$emit('edit', k)"
              >
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  <path d="m15 5 4 4" />
                </svg>
              </button>
              <button
                class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-gray-600 hover:text-accent-amber hover:bg-white/[0.04] transition-colors p-1"
                aria-label="Rotate API key"
                title="Rotate key"
                @click.stop="$emit('rotate', k)"
              >
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21.5 2v6h-6" />
                  <path d="M2.5 22v-6h6" />
                  <path d="M2.5 12a10 10 0 0 1 16.5-5.7L21.5 8" />
                  <path d="M21.5 12a10 10 0 0 1-16.5 5.7L2.5 16" />
                </svg>
              </button>
              <button
                class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-gray-600 hover:text-accent-rose hover:bg-white/[0.04] transition-colors p-1"
                aria-label="Delete API key"
                title="Delete key"
                @click.stop="$emit('remove', k)"
              >
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </OverlayScrollbars>
</template>
