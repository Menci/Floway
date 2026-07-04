<script setup lang="ts">
import { computed } from 'vue';

import type { UpstreamRecord } from '../../api/types.ts';
import { formatClaudeCodeSubscriptionType } from '../../lib/claude-code-format.ts';
import { assertNever } from '../../utils/assert-never.ts';
import { copilotAccountTypeDisplay } from '../../utils/copilot.ts';
import { providerBadgeClass, providerMeta } from '../upstreams/provider-meta.ts';

const props = defineProps<{
  upstream: UpstreamRecord;
  modelCount: number;
  moveUpDisabled: boolean;
  moveDownDisabled: boolean;
}>();

defineEmits<{
  toggleEnabled: [next: boolean];
  moveUp: [];
  moveDown: [];
  edit: [];
  delete: [];
}>();

const modelSummary = computed(() => `${props.modelCount} model${props.modelCount === 1 ? '' : 's'}`);

const subtitle = computed(() => {
  const u = props.upstream;
  switch (u.kind) {
  case 'azure': return u.config.endpoint;
  case 'custom': return u.config.baseUrl;
  case 'copilot': {
    const user = u.config.user;
    return user.login
      ? `@${user.login} · ${copilotAccountTypeDisplay(u.state)}`
      : 'GitHub Copilot account';
  }
  case 'codex': {
    const account = u.config.accounts[0];
    return `${account.email} · ${account.planType}`;
  }
  case 'claude-code': {
    const account = u.config.accounts[0];
    // email is null for tokens that lack `user:profile`; fall back to the
    // short accountUuid prefix so the row still has a stable identifier.
    const label = account.email ?? `${account.accountUuid.slice(0, 8)}…`;
    const subscription = formatClaudeCodeSubscriptionType(account.subscriptionType, account.rateLimitTier);
    return subscription ? `${label} · ${subscription}` : label;
  }
  case 'ollama': return u.config.baseUrl ?? 'Ollama endpoint';
  case 'cursor': {
    const account = u.config.accounts[0];
    return account.email;
  }
  }
  return assertNever(u);
});
</script>

<template>
  <div class="rounded-lg border border-white/5 bg-surface-800/80 p-3">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0 flex-1">
        <div class="mb-1.5 flex min-w-0 flex-wrap items-center gap-2">
          <span
            class="rounded border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide"
            :class="providerBadgeClass(upstream.kind)"
          >{{ providerMeta(upstream.kind).label }}</span>
          <span class="rounded bg-surface-900/70 px-2 py-0.5 text-[11px] font-medium text-gray-400">{{ modelSummary }}</span>
        </div>
        <p class="truncate text-sm font-semibold text-white">{{ upstream.name }}</p>
        <p class="truncate text-xs text-gray-500" :title="subtitle">{{ subtitle }}</p>
      </div>

      <div class="flex shrink-0 items-center justify-end gap-1.5">
        <label class="relative inline-flex h-7 w-12 cursor-pointer items-center" title="Toggle upstream">
          <input
            type="checkbox"
            class="peer sr-only"
            :checked="upstream.enabled"
            aria-label="Toggle upstream enabled"
            @change="(e: Event) => $emit('toggleEnabled', (e.target as HTMLInputElement).checked)"
          >
          <span class="h-6 w-11 rounded-full bg-surface-600 transition-colors peer-checked:bg-accent-emerald/70" />
          <span class="absolute left-1 h-4 w-4 rounded-full bg-gray-300 transition-transform peer-checked:translate-x-5 peer-checked:bg-white" />
        </label>

        <button
          type="button"
          class="inline-flex h-9 w-9 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan disabled:pointer-events-none disabled:opacity-30"
          :disabled="moveUpDisabled"
          aria-label="Move upstream up"
          title="Move up"
          @click="$emit('moveUp')"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="m18 15-6-6-6 6" />
          </svg>
        </button>
        <button
          type="button"
          class="inline-flex h-9 w-9 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan disabled:pointer-events-none disabled:opacity-30"
          :disabled="moveDownDisabled"
          aria-label="Move upstream down"
          title="Move down"
          @click="$emit('moveDown')"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        <button
          type="button"
          class="inline-flex h-9 w-9 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan"
          aria-label="Edit upstream"
          title="Edit"
          @click="$emit('edit')"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            <path d="m15 5 4 4" />
          </svg>
        </button>
        <button
          type="button"
          class="inline-flex h-9 w-9 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-rose"
          aria-label="Delete upstream"
          title="Delete"
          @click="$emit('delete')"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>
