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
// Quota is a pure query — no draft mutation and no persistence.
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
