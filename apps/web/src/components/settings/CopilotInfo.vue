<script setup lang="ts">
import { Card } from '@floway-dev/ui';
import { onMounted, ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { CopilotQuotaSnapshot, CopilotUpstreamConfig } from '../../api/types.ts';

const props = defineProps<{
  upstreamId: string;
  config: CopilotUpstreamConfig;
}>();

const api = useApi();
const quota = ref<CopilotQuotaSnapshot | null>(null);
const quotaError = ref<string | null>(null);
const loadingQuota = ref(false);

const loadQuota = async () => {
  loadingQuota.value = true;
  quotaError.value = null;
  const { data, error } = await callApi<CopilotQuotaSnapshot>(
    () => api.api.upstreams[':id'].copilot.quota.$get({ param: { id: props.upstreamId } }),
  );
  loadingQuota.value = false;
  if (error) {
    quotaError.value = error.message;
    return;
  }
  quota.value = data ?? null;
};

const formatPercent = (entitlement: number, remaining: number) => {
  if (entitlement <= 0) return null;
  const used = Math.max(0, entitlement - remaining);
  return Math.min(100, Math.round((used / entitlement) * 100));
};

onMounted(() => { void loadQuota(); });
</script>

<template>
  <div class="space-y-4">
    <Card :padded="false" class="space-y-3 p-4">
      <div class="flex items-center gap-3">
        <img
          v-if="config.user.avatar_url"
          :src="config.user.avatar_url"
          :alt="config.user.login"
          class="size-10 rounded-full"
        >
        <div>
          <p class="text-sm font-medium text-white">{{ config.user.name ?? config.user.login }}</p>
          <p class="text-xs text-gray-400">@{{ config.user.login }} · {{ config.accountType }}</p>
        </div>
      </div>
    </Card>

    <Card :padded="false" class="space-y-3 p-4">
      <header class="flex items-center justify-between">
        <h4 class="text-sm font-semibold text-white">Premium quota</h4>
        <button
          type="button"
          class="text-xs text-accent-cyan hover:text-accent-cyan"
          :disabled="loadingQuota"
          @click="loadQuota"
        >
          {{ loadingQuota ? 'Loading…' : 'Refresh' }}
        </button>
      </header>
      <div v-if="quotaError" class="text-xs text-accent-rose">{{ quotaError }}</div>
      <template v-else-if="quota?.quota_snapshots?.premium_interactions">
        <div class="space-y-1.5">
          <div class="flex items-baseline justify-between text-sm">
            <span class="text-white">{{ quota.quota_snapshots.premium_interactions.entitlement - quota.quota_snapshots.premium_interactions.remaining }} / {{ quota.quota_snapshots.premium_interactions.entitlement }}</span>
            <span class="text-xs text-gray-400">
              {{ formatPercent(quota.quota_snapshots.premium_interactions.entitlement, quota.quota_snapshots.premium_interactions.remaining) }}% used
            </span>
          </div>
          <div class="h-1.5 overflow-hidden rounded-full bg-surface-700">
            <div
              class="h-full bg-accent-cyan transition-[width]"
              :style="{ width: `${formatPercent(quota.quota_snapshots.premium_interactions.entitlement, quota.quota_snapshots.premium_interactions.remaining) ?? 0}%` }"
            />
          </div>
          <p v-if="quota.quota_snapshots.premium_interactions.reset_date" class="text-xs text-gray-500">
            Resets on {{ new Date(quota.quota_snapshots.premium_interactions.reset_date).toLocaleDateString() }}
          </p>
        </div>
      </template>
      <p v-else-if="!loadingQuota" class="text-xs text-gray-500">No premium quota reported.</p>
    </Card>
  </div>
</template>
