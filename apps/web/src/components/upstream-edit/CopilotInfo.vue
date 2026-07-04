<script setup lang="ts">
import { computed, ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { CopilotQuotaSnapshot, UpstreamRecord } from '../../api/types.ts';
import { toRecordEnvelope } from '../../api/types.ts';
import { copilotAccountTypeDisplay } from '../../utils/copilot.ts';
import { Card } from '@floway-dev/ui';

type CopilotUpstreamRecord = Extract<UpstreamRecord, { kind: 'copilot' }>;

const props = defineProps<{
  draft: CopilotUpstreamRecord;
}>();

defineEmits<{
  error: [message: string];
}>();

const accountTypeDisplay = computed(() => copilotAccountTypeDisplay(props.draft.state));

const api = useApi();
// Quota is a pure query — no draft mutation and no persistence. The
// dashboard renders whatever the upstream reports in place; if the
// operator wants a fresh snapshot they click Refresh.
const quota = ref<CopilotQuotaSnapshot | null>(null);
const quotaError = ref<string | null>(null);
const loadingQuota = ref(false);

const loadQuota = async () => {
  loadingQuota.value = true;
  quotaError.value = null;
  const { data, error } = await callApi<CopilotQuotaSnapshot>(
    () => api.api.upstreams.copilot.quota.$post({ json: { record: toRecordEnvelope(props.draft) } }),
  );
  loadingQuota.value = false;
  if (error) {
    quotaError.value = error.message;
    return;
  }
  quota.value = data ?? null;
};

// The token is fetched lazily on first click rather than on mount so we
// don't burn a GitHub round trip for every editor visit; the operator's
// mental model is "the number I see is the number I asked for."
void loadQuota;

const premium = computed(() => quota.value?.quota_snapshots?.premium_interactions);

const usedPercent = computed(() => {
  const p = premium.value;
  if (!p || p.entitlement <= 0) return null;
  const used = Math.max(0, p.entitlement - p.remaining);
  return Math.min(100, Math.round((used / p.entitlement) * 100));
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
        <h4 class="text-sm font-semibold text-white">Premium quota</h4>
        <button
          type="button"
          class="text-xs text-accent-cyan hover:text-accent-cyan"
          :disabled="loadingQuota"
          @click="loadQuota"
        >
          {{ loadingQuota ? 'Loading…' : (quota ? 'Refresh' : 'Load') }}
        </button>
      </header>
      <div v-if="quotaError" class="text-xs text-accent-rose">{{ quotaError }}</div>
      <template v-else-if="premium">
        <div class="space-y-1.5">
          <div class="flex items-baseline justify-between text-sm">
            <span class="text-white">{{ premium.entitlement - premium.remaining }} / {{ premium.entitlement }}</span>
            <span class="text-xs text-gray-400">{{ usedPercent }}% used</span>
          </div>
          <div class="h-1.5 overflow-hidden rounded-full bg-surface-700">
            <div
              class="h-full bg-accent-cyan transition-[width]"
              :style="{ width: `${usedPercent ?? 0}%` }"
            />
          </div>
          <p v-if="premium.reset_date" class="text-xs text-gray-500">
            Resets on {{ new Date(premium.reset_date).toLocaleDateString() }}
          </p>
        </div>
      </template>
      <p v-else-if="!loadingQuota" class="text-xs text-gray-500">Click Load to fetch the current premium quota.</p>
    </Card>
  </div>
</template>
