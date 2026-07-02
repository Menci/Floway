<script setup lang="ts">

import CopilotDeviceFlow from './CopilotDeviceFlow.vue';
import CopilotInfo from './CopilotInfo.vue';
import type { CopilotQuotaSnapshot, ProxyFallbackEntry, UpstreamRecord } from '../../api/types.ts';

type CopilotUpstreamRecord = Extract<UpstreamRecord, { kind: 'copilot' }>;

defineProps<
  | {
    mode: 'create';
    record: null;
    initialQuota?: CopilotQuotaSnapshot | null;
    initialQuotaError?: string | null;
    // Current edit-form chain forwarded into the device-flow poll so the
    // GitHub-side calls honor the in-progress proxy override.
    proxyFallbackList: ProxyFallbackEntry[];
  }
  | {
    mode: 'edit';
    record: CopilotUpstreamRecord;
    initialQuota?: CopilotQuotaSnapshot | null;
    initialQuotaError?: string | null;
    proxyFallbackList: ProxyFallbackEntry[];
  }
>();

defineEmits<{ completed: [upstream: UpstreamRecord | undefined] }>();
</script>

<template>
  <CopilotInfo
    v-if="record"
    :upstream-id="record.id"
    :config="record.config"
    :state="record.state"
    :initial-quota="initialQuota"
    :initial-quota-error="initialQuotaError"
  />
  <CopilotDeviceFlow v-else :proxy-fallback-list="proxyFallbackList" @completed="u => $emit('completed', u)" />
</template>
