<script setup lang="ts">
import CopilotDeviceFlow from './CopilotDeviceFlow.vue';
import CopilotInfo from './CopilotInfo.vue';
import type { UpstreamRecord } from '../../api/types.ts';

type CopilotUpstreamRecord = Extract<UpstreamRecord, { kind: 'copilot' }>;

// The draft's `githubToken` is the sole discriminator between "run device
// flow" (blueprint / freshly created row) and "show account info" (post-
// exchange). Once the device-flow completion emits a patch, the parent
// merges it into draft.config.githubToken and this component re-renders
// into the info view without any local state.
defineProps<{
  draft: CopilotUpstreamRecord;
  saving: boolean;
}>();

defineEmits<{
  patched: [patch: { config?: unknown; state?: unknown }];
  'save-and-open-edit': [];
}>();
</script>

<template>
  <CopilotInfo
    v-if="draft.config.githubToken"
    :draft="draft"
    :saving="saving"
    @save-and-open-edit="$emit('save-and-open-edit')"
  />
  <CopilotDeviceFlow v-else :draft="draft" @patched="p => $emit('patched', p)" />
</template>
