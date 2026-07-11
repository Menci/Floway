<script setup lang="ts">
// Identity + state + quota summary for one Codex account in an upstream's
// pool. Pure presentational card — no API calls live here.

import { computed } from 'vue';

import type { CodexAccountCredentialState, CodexAccountIdentity, CodexQuotaSnapshot, UpstreamRecord } from '../../api/types.ts';
import UpstreamBadge from '../upstreams/UpstreamBadge.vue';
import { Badge, Card } from '@floway-dev/ui';

const props = defineProps<{
  record: UpstreamRecord;
}>();

interface QuotaWindowView {
  label: string;
  percent?: number;
  resetAt?: string;
  windowMinutes?: number;
}

interface QuotaEntryView {
  key: string;
  label: string;
  quota: CodexQuotaSnapshot;
  rateLimitedUntil: string | null;
  windows: QuotaWindowView[];
}

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

const quotaMap = computed(() => codexRecord.value.codex_quota ?? null);

const formatTimestamp = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
};

const formatPercent = (n: number | undefined): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `${Math.max(0, Math.min(100, Math.round(n)))}%`;
};

const futureTimestamp = (iso: string | undefined, now: number): string | null => {
  if (typeof iso !== 'string') return null;
  return new Date(iso).getTime() > now ? iso : null;
};

const quotaEntries = computed<QuotaEntryView[]>(() => {
  const map = quotaMap.value;
  if (!map) return [];
  const now = Date.now();
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, quota]) => ({
      key,
      label: quota.active_limit ?? key,
      quota,
      rateLimitedUntil: futureTimestamp(quota.ratelimited_until, now),
      windows: [
        { label: 'Primary window', percent: quota.primary_used_percent, resetAt: quota.primary_reset_after_at, windowMinutes: quota.primary_window_minutes },
        { label: 'Secondary window', percent: quota.secondary_used_percent, resetAt: quota.secondary_reset_after_at, windowMinutes: quota.secondary_window_minutes },
      ],
    }));
});

const accountCredits = computed<CodexQuotaSnapshot | null>(() => {
  const map = quotaMap.value;
  if (!map) return null;
  let newest: CodexQuotaSnapshot | null = null;
  let newestObservedAt = Number.NEGATIVE_INFINITY;
  for (const quota of Object.values(map)) {
    if (quota.credits_balance === undefined && quota.credits_has_credits === undefined) continue;
    const observedAt = new Date(quota.observed_at).getTime();
    if (observedAt > newestObservedAt) {
      newest = quota;
      newestObservedAt = observedAt;
    }
  }
  return newest;
});

const badge = computed<{ tone: 'rose' | 'amber' | 'emerald'; label: string; detail?: string }>(() => {
  const c = credential.value;
  if (c?.state === 'session_terminated') {
    return { tone: 'rose', label: 'Session terminated — re-import to recover', detail: c.state_message };
  }
  if (c?.state === 'refresh_failed') {
    return { tone: 'rose', label: 'Refresh failed — re-import to recover', detail: c.state_message };
  }
  const rateLimitedUntil = quotaEntries.value
    .map(entry => entry.rateLimitedUntil)
    .filter((until): until is string => until !== null)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
  if (rateLimitedUntil) {
    return { tone: 'rose', label: `Rate-limited until ${formatTimestamp(rateLimitedUntil)}` };
  }
  const usages = quotaEntries.value
    .flatMap(entry => [entry.quota.primary_used_percent, entry.quota.secondary_used_percent])
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
</script>

<template>
  <Card :padded="false" class="space-y-4 p-4">
    <div class="flex items-start gap-3">
      <UpstreamBadge
        :kind="record.kind"
        :color="record.color"
        variant="swatch"
        class="size-10 shrink-0 rounded-full"
      >
        <i class="i-simple-icons-openai size-5" />
      </UpstreamBadge>
      <div class="min-w-0 flex-1 space-y-1">
        <p class="truncate text-sm font-medium text-white">{{ account.email }}</p>
        <div class="flex flex-wrap items-center gap-2 text-xs text-gray-400">
          <Badge tone="violet" size="sm" class="!uppercase tracking-wide">{{ account.planType }}</Badge>
          <Badge v-if="accountCredits?.credits_has_credits === false" tone="rose" size="sm">no credits</Badge>
          <Badge v-else-if="accountCredits?.credits_balance !== undefined" tone="zinc" size="sm">
            credits: {{ accountCredits.credits_balance }}
          </Badge>
          <span class="font-mono text-[11px] text-gray-500" :title="account.chatgptAccountId">{{ accountIdShort }}</span>
        </div>
      </div>
      <Badge :tone="badge.tone" size="sm">{{ badge.label }}</Badge>
    </div>

    <p v-if="badge.detail" class="text-xs text-gray-500">{{ badge.detail }}</p>

    <template v-if="quotaEntries.length">
      <div class="space-y-3">
        <section v-for="entry in quotaEntries" :key="entry.key" class="space-y-3 rounded-xl border border-white/[0.06] bg-surface-900/40 p-3">
          <div class="flex min-w-0 items-baseline justify-between gap-3">
            <h4 class="min-w-0 truncate text-sm font-medium text-gray-200" :title="entry.label">{{ entry.label }}</h4>
            <span class="shrink-0 text-[11px] uppercase tracking-wide text-gray-500">active limit</span>
          </div>

          <div class="space-y-3">
            <div v-for="w in entry.windows" :key="`${entry.key}:${w.label}`" class="space-y-1">
              <div class="flex items-baseline justify-between text-xs">
                <span class="text-gray-300">{{ w.label }}</span>
                <span class="text-gray-500">
                  {{ formatPercent(w.percent) }}<template v-if="w.windowMinutes"> · {{ w.windowMinutes }} min window</template>
                </span>
              </div>
              <div class="h-1.5 overflow-hidden rounded-full bg-surface-700">
                <UpstreamBadge
                  :kind="record.kind"
                  :color="record.color"
                  variant="fill"
                  class="block h-full transition-[width]"
                  :style="{ width: `${Math.max(0, Math.min(100, Math.round(w.percent ?? 0)))}%` }"
                />
              </div>
              <p v-if="w.resetAt" class="text-[11px] text-gray-500">Resets at {{ formatTimestamp(w.resetAt) }}</p>
            </div>
          </div>

          <footer class="flex flex-wrap items-center gap-3 border-t border-white/[0.06] pt-3 text-[11px] text-gray-500">
            <span v-if="entry.rateLimitedUntil">rate-limited until {{ formatTimestamp(entry.rateLimitedUntil) }}</span>
            <span>observed {{ formatTimestamp(entry.quota.observed_at) }}</span>
          </footer>
        </section>
      </div>

      <footer v-if="credential?.state_updated_at" class="border-t border-white/[0.06] pt-3 text-[11px] text-gray-500">
        state updated {{ formatTimestamp(credential.state_updated_at) }}
      </footer>
    </template>

    <p v-else class="text-xs text-gray-500">No quota snapshots yet. Make Codex calls to populate.</p>
  </Card>
</template>
