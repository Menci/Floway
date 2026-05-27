<script setup lang="ts">
// Copilot device-flow panel — extracted from CopilotAuthDialog so it can be
// embedded inside UpstreamFormDialog (create mode, copilot provider) without
// stacking a Dialog inside a Dialog.

import { Button, Code, Spinner } from '@floway-dev/ui';
import { onUnmounted, ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { DeviceFlowPoll, DeviceFlowStart, UpstreamRecord } from '../../api/types.ts';

const emit = defineEmits<{ completed: [upstream: UpstreamRecord | undefined] }>();

const api = useApi();

const flow = ref<DeviceFlowStart | null>(null);
const starting = ref(false);
const polling = ref(false);
const error = ref<string | null>(null);
let pollTimer: number | null = null;

const stopPolling = () => {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  polling.value = false;
};

const reset = () => {
  flow.value = null;
  error.value = null;
  starting.value = false;
  stopPolling();
};

const start = async () => {
  reset();
  starting.value = true;
  const { data, error: err } = await callApi<DeviceFlowStart>(
    () => api.api.upstreams.copilot.auth.start.$post(),
  );
  starting.value = false;
  if (err) {
    error.value = err.message;
    return;
  }
  if (!data) return;
  flow.value = data;
  scheduleNextPoll(data.interval || 5);
};

const scheduleNextPoll = (intervalSec: number) => {
  stopPolling();
  polling.value = true;
  pollTimer = window.setInterval(() => { void pollOnce(intervalSec); }, intervalSec * 1000);
};

const pollOnce = async (currentInterval: number) => {
  if (!flow.value) return;
  const { data, error: err } = await callApi<DeviceFlowPoll>(
    () => api.api.upstreams.copilot.auth.poll.$post({ json: { device_code: flow.value!.device_code } }),
  );
  if (err) return; // Transient — keep polling.
  if (!data) return;
  if (data.status === 'complete') {
    stopPolling();
    emit('completed', data.upstream);
    return;
  }
  if (data.status === 'slow_down') {
    scheduleNextPoll((data.interval ?? currentInterval) + 1);
    return;
  }
  if (data.status === 'error') {
    error.value = data.error ?? 'Authorization failed';
    stopPolling();
  }
};

defineExpose({ reset });

onUnmounted(stopPolling);
</script>

<template>
  <div class="space-y-5">
    <div class="rounded-lg border border-white/10 bg-surface-800/40 p-4">
      <p class="text-sm font-semibold text-white">Connect GitHub Copilot</p>
      <p class="mt-1 text-xs leading-relaxed text-gray-500">
        GitHub device auth creates or refreshes a Copilot upstream for the
        signed-in account.
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
