<script setup lang="ts">
import { onUnmounted, ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { DeviceFlowPoll, DeviceFlowStart, UpstreamRecord } from '../../api/types.ts';
import { toRecordEnvelope } from '../../api/types.ts';
import { Button, Code, Spinner } from '@floway-dev/ui';

type CopilotUpstreamRecord = Extract<UpstreamRecord, { kind: 'copilot' }>;

const props = defineProps<{
  // The draft record is forwarded verbatim into the poll body so the
  // GitHub-side egress honors the in-progress proxy chain being edited.
  draft: CopilotUpstreamRecord;
}>();

const emit = defineEmits<{
  patched: [patch: { config?: unknown; state?: unknown }];
}>();

const api = useApi();

const flow = ref<DeviceFlowStart | null>(null);
const starting = ref(false);
const polling = ref(false);
const error = ref<string | null>(null);
// Recursive-setTimeout scheduling (not setInterval) so a poll that outruns
// its cadence cannot fire a second concurrent request; `inFlight` gates
// re-entry, and `unmounted` guards against a late resolve emitting `patched`
// after the component tore down.
let pollTimer: number | null = null;
let inFlight = false;
let unmounted = false;

const stopPolling = () => {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
  polling.value = false;
};

const pollOnce = async (intervalSec: number) => {
  if (!flow.value || inFlight) return;
  inFlight = true;
  try {
    const { data, error: err } = await callApi<DeviceFlowPoll>(
      () => api.api.upstreams.copilot.oauth['device-login'].poll.$post({
        json: { record: toRecordEnvelope(props.draft), deviceCode: flow.value!.device_code },
      }),
    );
    if (unmounted) return;
    if (err) { scheduleNextPoll(intervalSec); return; } // transient
    if (data.status === 'complete') {
      stopPolling();
      emit('patched', data.patch);
      return;
    }
    if (data.status === 'slow_down') { scheduleNextPoll(data.interval + 1); return; }
    if (data.status === 'error') {
      error.value = data.error;
      stopPolling();
      return;
    }
    // status === 'pending': re-queue at the same cadence.
    scheduleNextPoll(intervalSec);
  } finally {
    inFlight = false;
  }
};

const scheduleNextPoll = (intervalSec: number) => {
  if (unmounted) return;
  polling.value = true;
  pollTimer = window.setTimeout(() => { void pollOnce(intervalSec); }, intervalSec * 1000);
};

const start = async () => {
  flow.value = null;
  error.value = null;
  stopPolling();
  starting.value = true;
  const { data, error: err } = await callApi<DeviceFlowStart>(
    () => api.api.upstreams.copilot.oauth['device-login'].start.$post(),
  );
  starting.value = false;
  if (err) {
    error.value = err.message;
    return;
  }
  flow.value = data;
  scheduleNextPoll(data.interval);
};

onUnmounted(() => {
  unmounted = true;
  stopPolling();
});
</script>

<template>
  <div class="space-y-5">
    <div class="rounded-lg border border-white/10 bg-surface-800/40 p-4">
      <p class="text-sm font-semibold text-white">Connect GitHub Copilot</p>
      <p class="mt-1 text-xs leading-relaxed text-gray-500">
        GitHub device auth binds the signed-in account's Copilot subscription to this upstream.
      </p>

      <div v-if="error" class="mt-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">{{ error }}</div>

      <div v-if="!flow && !starting" class="mt-3">
        <Button @click="start">Connect GitHub</Button>
      </div>

      <div v-else-if="starting" class="mt-3 flex items-center gap-2 text-sm text-gray-400">
        <Spinner class="size-4" /> Requesting code…
      </div>

      <div v-else-if="flow" class="mt-4 space-y-4">
        <div>
          <p class="text-xs font-medium text-gray-500">Device code</p>
          <p class="mt-1 font-mono text-2xl tracking-[0.3em] text-white">{{ flow.user_code }}</p>
        </div>

        <div>
          <p class="text-xs font-medium text-gray-500">Verification URL</p>
          <a :href="flow.verification_uri" target="_blank" rel="noopener" class="mt-1 inline-block text-sm text-accent-cyan hover:underline">
            {{ flow.verification_uri }}
          </a>
        </div>

        <Code :code="`Visit ${flow.verification_uri} and enter ${flow.user_code}`" :copyable="false" />

        <p class="flex items-center gap-2 text-xs text-gray-500">
          <Spinner v-if="polling" class="size-3" /> Waiting for authorization…
        </p>
      </div>
    </div>
  </div>
</template>
