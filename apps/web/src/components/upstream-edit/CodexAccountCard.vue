<script setup lang="ts">
// Identity + state + quota summary for one Codex account in an upstream's
// pool. Pure presentational card — no API calls live here.

import { computed } from 'vue';

import type { CodexAccountCredentialState, CodexAccountIdentity, UpstreamRecord } from '../../api/types.ts';
import { providerSwatchClass } from '../upstreams/provider-meta.ts';
import { Badge, Card } from '@floway-dev/ui';

const props = defineProps<{
  record: UpstreamRecord;
}>();

// Narrow once: this card only renders inside a codex upstream's edit page.
// Pinning the narrow at the script-setup boundary lets every computed below
// reach `config` / `state` / `codex_quota` without `as` casts.
const codexRecord = computed(() => {
  if (props.record.kind !== 'codex') {
    throw new Error(`CodexAccountCard requires a codex upstream, got ${props.record.kind}`);
  }
  return props.record;
});

const account = computed<CodexAccountIdentity>(() => codexRecord.value.config.accounts[0]);

const credential = computed<CodexAccountCredentialState | null>(() => {
  const raw = codexRecord.value.state;
  if (!raw || !Array.isArray(raw.accounts)) return null;
  return raw.accounts.find(a => a.chatgptAccountId === account.value.chatgptAccountId) ?? null;
});

const quota = computed(() => codexRecord.value.codex_quota ?? null);

const formatTimestamp = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
};

const formatPercent = (n: number | undefined): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `${Math.max(0, Math.min(100, Math.round(n)))}%`;
};

const badge = computed<{ tone: 'rose' | 'amber' | 'emerald'; label: string; detail?: string }>(() => {
  const c = credential.value;
  if (c?.state === 'session_terminated') {
    return { tone: 'rose', label: 'Session terminated — re-import to recover', detail: c.state_message };
  }
  if (c?.state === 'refresh_failed') {
    return { tone: 'rose', label: 'Refresh failed — re-import to recover', detail: c.state_message };
  }
  const until = quota.value?.ratelimited_until;
  if (until && new Date(until).getTime() > Date.now()) {
    return { tone: 'rose', label: `Rate-limited until ${formatTimestamp(until)}` };
  }
  const usages = [quota.value?.primary_used_percent, quota.value?.secondary_used_percent]
    .filter((v): v is number => typeof v === 'number');
  const heaviest = usages.length ? Math.max(...usages) : null;
  if (heaviest !== null && heaviest >= 80) {
    return { tone: 'amber', label: `Heavy usage (${heaviest}%)` };
  }
  return { tone: 'emerald', label: 'Active' };
});

const accountIdShort = computed(() => {
  const id = account.value.chatgptAccountId;
  if (id.length <= 18) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
});

const windows = computed(() => {
  const q = quota.value;
  if (!q) return [];
  return [
    { label: 'Primary window', percent: q.primary_used_percent, resetAt: q.primary_reset_after_at, windowMinutes: q.primary_window_minutes },
    { label: 'Secondary window', percent: q.secondary_used_percent, resetAt: q.secondary_reset_after_at, windowMinutes: q.secondary_window_minutes },
  ];
});
</script>

<template>
  <Card :padded="false" class="space-y-4 p-4">
    <div class="flex items-start gap-3">
      <div class="flex size-10 shrink-0 items-center justify-center rounded-full" :class="providerSwatchClass('codex')">
        <i class="i-simple-icons-openai size-5" />
      </div>
      <div class="min-w-0 flex-1 space-y-1">
        <p class="truncate text-sm font-medium text-white">{{ account.email }}</p>
        <div class="flex flex-wrap items-center gap-2 text-xs text-gray-400">
          <Badge tone="violet" size="sm" class="!uppercase tracking-wide">{{ account.planType }}</Badge>
          <span class="font-mono text-[11px] text-gray-500" :title="account.chatgptAccountId">{{ accountIdShort }}</span>
        </div>
      </div>
      <Badge :tone="badge.tone" size="sm">{{ badge.label }}</Badge>
    </div>

    <p v-if="badge.detail" class="text-xs text-gray-500">{{ badge.detail }}</p>

    <template v-if="quota">
      <div class="space-y-3">
        <div v-for="w in windows" :key="w.label" class="space-y-1">
          <div class="flex items-baseline justify-between text-xs">
            <span class="text-gray-300">{{ w.label }}</span>
            <span class="text-gray-500">
              {{ formatPercent(w.percent) }}<template v-if="w.windowMinutes"> · {{ w.windowMinutes }} min window</template>
            </span>
          </div>
          <div class="h-1.5 overflow-hidden rounded-full bg-surface-700">
            <div
              class="h-full bg-accent-violet transition-[width]"
              :style="{ width: `${Math.max(0, Math.min(100, Math.round(w.percent ?? 0)))}%` }"
            />
          </div>
          <p v-if="w.resetAt" class="text-[11px] text-gray-500">Resets at {{ formatTimestamp(w.resetAt) }}</p>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2 text-[11px]">
        <Badge v-if="quota.active_limit" tone="zinc" size="sm">active limit: {{ quota.active_limit }}</Badge>
        <Badge v-if="quota.credits_balance !== undefined" tone="zinc" size="sm">
          credits: {{ quota.credits_balance }}
        </Badge>
        <Badge v-if="quota.credits_has_credits === false" tone="rose" size="sm">no credits</Badge>
      </div>

      <footer class="flex flex-wrap items-center gap-3 border-t border-white/[0.06] pt-3 text-[11px] text-gray-500">
        <span v-if="credential?.state_updated_at">state updated {{ formatTimestamp(credential.state_updated_at) }}</span>
        <span>observed {{ formatTimestamp(quota.observed_at) }}</span>
      </footer>
    </template>

    <p v-else class="text-xs text-gray-500">No quota snapshot yet. Make a Codex call to populate.</p>
  </Card>
</template>
