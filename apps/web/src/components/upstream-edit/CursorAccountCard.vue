<script setup lang="ts">
import { computed, ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { CursorDashboardUsage } from '../../api/types.ts';
import { Card } from '@floway-dev/ui';

// String rather than a strict enum so the caller can pass "unknown" when the
// state slot is not yet populated. Only 'active' is treated specially: the
// Refresh button is disabled otherwise.
const props = defineProps<{
  upstreamId: string;
  accountState: string;
  initialQuota?: CursorDashboardUsage | null;
  initialQuotaError?: string | null;
}>();

const api = useApi();
const quota = ref<CursorDashboardUsage | null>(props.initialQuota ?? null);
const quotaError = ref<string | null>(props.initialQuotaError ?? null);
const sessionExpired = ref(false);
const loadingQuota = ref(false);

// Cents → dollars for display. Null-safe; returns "—" when Cursor omits the
// plan ceiling (planUsage is empty for a fresh cycle with no plan tier).
const formatDollars = (cents: number | null): string => {
  if (cents === null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
};

const totalDollars = computed(() => formatDollars(quota.value?.totalSpendCents ?? null));
const limitDollars = computed(() => formatDollars(quota.value?.limitCents ?? null));

const resetLabel = computed(() => {
  const ms = quota.value?.billingCycleEndMs;
  if (!ms) return null;
  return new Date(ms).toLocaleString();
});

const loadQuota = async () => {
  if (props.accountState !== 'active') return;
  loadingQuota.value = true;
  quotaError.value = null;
  sessionExpired.value = false;
  const { data, error } = await callApi<CursorDashboardUsage>(
    () => api.api.upstreams[':id'].cursor.quota.$get({ param: { id: props.upstreamId } }),
  );
  loadingQuota.value = false;
  if (error) {
    quotaError.value = error.message;
    // The control-plane route maps rejected-session errors (WorkOS redirect
    // or dead refresh_token) to HTTP 502 with `{ kind: 'session_expired' }`
    // in the body — the 401 status can't be used here because authFetch
    // treats any 401 as *our* session expiring and force-logs-out.
    const raw = error.raw as { kind?: string } | undefined;
    if (raw?.kind === 'session_expired') sessionExpired.value = true;
    return;
  }
  quota.value = data ?? null;
};

interface UsageRow {
  label: string;
  percent: number;
}

const rows = computed<UsageRow[]>(() => {
  const q = quota.value;
  if (!q) return [];
  return [
    { label: 'Total', percent: q.totalPercentUsed },
    { label: 'Auto + Composer', percent: q.autoPercentUsed },
    { label: 'API', percent: q.apiPercentUsed },
  ];
});
</script>

<template>
  <Card :padded="false" class="space-y-3 p-4">
    <header class="flex items-center justify-between">
      <h4 class="text-sm font-semibold text-white">Subscription usage</h4>
      <button
        type="button"
        class="text-xs text-accent-cyan hover:text-accent-cyan disabled:opacity-40"
        :disabled="loadingQuota || accountState !== 'active'"
        @click="loadQuota"
      >
        {{ loadingQuota ? 'Loading…' : 'Refresh' }}
      </button>
    </header>

    <p v-if="accountState !== 'active'" class="text-xs text-accent-rose">
      Account is {{ accountState }} — re-import the credential to fetch usage.
    </p>

    <template v-else-if="quotaError">
      <p class="text-xs text-accent-rose">{{ quotaError }}</p>
      <p v-if="sessionExpired" class="text-xs text-gray-500">
        Use the Re-import credential button above to recover.
      </p>
    </template>

    <template v-else-if="quota">
      <p class="text-sm text-white">
        {{ totalDollars }} <span class="text-xs text-gray-500">of {{ limitDollars }} this cycle</span>
      </p>
      <div class="space-y-2.5">
        <div v-for="row in rows" :key="row.label" class="space-y-1">
          <div class="flex items-baseline justify-between text-xs">
            <span class="text-gray-300">{{ row.label }}</span>
            <span class="text-gray-400">{{ row.percent.toFixed(1) }}%</span>
          </div>
          <div class="h-1.5 overflow-hidden rounded-full bg-surface-700">
            <div class="h-full bg-accent-cyan transition-[width]" :style="{ width: `${row.percent}%` }" />
          </div>
        </div>
      </div>
      <p v-if="resetLabel" class="text-xs text-gray-500">Resets at {{ resetLabel }}</p>
    </template>

    <p v-else-if="!loadingQuota" class="text-xs text-gray-500">
      No usage snapshot yet. Click Refresh to fetch.
    </p>
  </Card>
</template>
