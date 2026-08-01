<script setup lang="ts">
import { computed, ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { CopilotQuotaSnapshot, UpstreamRecord } from '../../api/types.ts';
import { toRecordEnvelope } from '../../api/types.ts';
import { copilotAccountTypeDisplay } from '../../utils/copilot.ts';
import { Button, Card } from '@floway-dev/ui';

type CopilotUpstreamRecord = Extract<UpstreamRecord, { kind: 'copilot' }>;

const props = defineProps<{
  draft: CopilotUpstreamRecord;
  saving: boolean;
}>();

const emit = defineEmits<{
  'save-and-open-edit': [];
}>();

const isCreate = computed(() => props.draft.id === '');
const accountTypeDisplay = computed(() => copilotAccountTypeDisplay(props.draft.state));

const api = useApi();
// The persisted snapshot is whatever source saw the seat last — the data plane
// harvests one from every upstream response, so it is normally current without
// anyone pressing anything. A manual refresh returns the same shape and is
// persisted server-side too; holding the reply locally just avoids re-fetching
// the record to display it.
const refreshed = ref<CopilotQuotaSnapshot | null>(null);
const refreshError = ref<string | null>(null);
const refreshing = ref(false);

const persisted = computed(() => props.draft.state?.quotaSnapshot ?? null);
const quota = computed(() => refreshed.value ?? persisted.value?.data ?? null);

const refresh = async () => {
  refreshing.value = true;
  refreshError.value = null;
  const { data, error } = await callApi<CopilotQuotaSnapshot>(
    () => api.api.upstreams.copilot.quota.$post({ json: { record: toRecordEnvelope(props.draft) } }),
  );
  refreshing.value = false;
  if (error) {
    refreshError.value = error.message;
    return;
  }
  refreshed.value = data ?? null;
};

// Every bucket the seat reports, in the upstream's own naming. A paid seat
// meters `premium_interactions` (or `premium_models`) against a real
// entitlement and reports `chat` / `completions` as unlimited; a free seat
// meters the latter two instead. Rendering whatever comes back keeps the card
// honest on both without pinning a known set of quota ids.
const allBuckets = computed(() => Object.entries(quota.value?.quotas ?? {}).map(([id, detail]) => ({
  id,
  label: id.replace(/_/g, ' '),
  detail,
  usedPercent: Math.min(100, Math.max(0, Math.round(100 - detail.percent_remaining))),
  used: Math.round(detail.entitlement - detail.quota_remaining),
})));

// An unlimited bucket has nothing to report, so the card shows only what is
// actually metered. A seat with no metered bucket at all still gets one row —
// otherwise the card would read as "no quota observed" when the truth is
// "nothing is capped". The premium bucket is the one an operator looks for, so
// it is the preferred stand-in; falling back to the first reported bucket
// keeps that working if GitHub renames it.
const buckets = computed(() => {
  const metered = allBuckets.value.filter(bucket => !bucket.detail.unlimited);
  if (metered.length > 0) return metered;
  const premium = allBuckets.value.find(bucket => bucket.id.startsWith('premium'));
  const standIn = premium ?? allBuckets.value[0];
  return standIn === undefined ? [] : [standIn];
});

const observedAt = computed(() => {
  const iso = quota.value?.observed_at;
  return iso === undefined ? null : new Date(iso).toLocaleString();
});

const resetsOn = computed(() => {
  const iso = quota.value?.reset_at ?? null;
  return iso === null ? null : new Date(iso).toLocaleDateString();
});
</script>

<template>
  <div class="space-y-4">
    <Card :padded="false" class="space-y-3 p-4">
      <div class="flex items-center gap-3">
        <img
          v-if="draft.config.user.avatar_url"
          :src="draft.config.user.avatar_url"
          :alt="draft.config.user.login"
          class="size-10 rounded-full"
        >
        <div>
          <p class="text-sm font-medium text-white">{{ draft.config.user.name ?? draft.config.user.login }}</p>
          <p class="text-xs text-gray-400">@{{ draft.config.user.login }} · {{ accountTypeDisplay }}</p>
        </div>
      </div>
    </Card>

    <Card :padded="false" class="space-y-3 p-4">
      <header class="flex items-center justify-between">
        <h4 class="text-sm font-semibold text-white">Quota</h4>
        <button
          type="button"
          class="text-xs text-accent-cyan hover:text-accent-cyan"
          :disabled="refreshing"
          @click="refresh"
        >
          {{ refreshing ? 'Refreshing…' : 'Refresh' }}
        </button>
      </header>
      <div v-if="refreshError" class="text-xs text-accent-rose">{{ refreshError }}</div>
      <template v-if="buckets.length > 0">
        <div v-for="bucket in buckets" :key="bucket.id" class="space-y-1.5">
          <div class="flex items-baseline justify-between text-sm">
            <span class="capitalize text-gray-300">{{ bucket.label }}</span>
            <span v-if="bucket.detail.unlimited" class="text-xs text-gray-400">Unlimited</span>
            <span v-else class="text-white">
              {{ bucket.used.toLocaleString() }} / {{ bucket.detail.entitlement.toLocaleString() }}
              <span class="text-xs text-gray-400">· {{ bucket.usedPercent }}% used</span>
            </span>
          </div>
          <div v-if="!bucket.detail.unlimited" class="h-1.5 overflow-hidden rounded-full bg-surface-700">
            <div
              class="h-full bg-accent-cyan transition-[width]"
              :style="{ width: `${bucket.usedPercent}%` }"
            />
          </div>
        </div>
        <p class="text-xs text-gray-500">
          <span v-if="resetsOn">Resets on {{ resetsOn }} · </span>Observed {{ observedAt }}
        </p>
      </template>
      <p v-else-if="!refreshing" class="text-xs text-gray-500">
        No quota observed yet. One arrives with the first request this upstream serves, or click Refresh.
      </p>
    </Card>

    <!-- Create-state prompt: the operator has completed the device flow but
         hasn't persisted the row yet, so the list-models endpoint has no DB
         id to key off. Offer an explicit save-and-open path that lands them
         on the edit page whose mount-time prime populates the catalog. The
         main Save button in the page footer instead returns to the list. -->
    <div
      v-if="isCreate"
      class="flex items-center justify-between gap-4 rounded-xl border border-[rgba(0,229,255,0.18)] bg-gradient-to-br from-[rgba(0,229,255,0.08)] to-[rgba(0,229,255,0.02)] px-4 py-3.5"
    >
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium text-white">Ready to save</p>
        <p class="text-xs text-gray-400">Save this Copilot upstream to load its model catalog for review.</p>
      </div>
      <Button :loading="saving" class="shrink-0" @click="emit('save-and-open-edit')">
        <i v-if="!saving" class="i-lucide-save size-3.5" />
        Save and load models
      </Button>
    </div>
  </div>
</template>
