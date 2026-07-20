<script setup lang="ts">
import { ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { CodexUltraConfig } from '../../api/types.ts';
import { Button, Input, Switch } from '@floway-dev/ui';

const props = defineProps<{
  initialConfig: CodexUltraConfig;
  initialError?: string | null;
}>();

const api = useApi();
const draft = ref<CodexUltraConfig>({ ...props.initialConfig });
const error = ref<string | null>(props.initialError ?? null);
const saving = ref(false);

const save = async () => {
  saving.value = true;
  const { data, error: saveError } = await callApi<CodexUltraConfig>(
    () => api.api['codex-ultra-config'].$put({ json: draft.value }),
  );
  saving.value = false;
  if (saveError) {
    error.value = saveError.message;
    return;
  }
  draft.value = { ...data };
  error.value = null;
};
</script>

<template>
  <div class="glass-card p-5 sm:p-6 animate-in delay-2">
    <div class="mb-4">
      <h3 class="mb-1 font-semibold text-white">Codex Ultra</h3>
      <p class="text-sm text-gray-400">Expose Codex's proactive multi-agent mode to models whose upstream catalog does not advertise it.</p>
    </div>

    <p v-if="error" class="mb-4 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">{{ error }}</p>

    <div class="rounded-xl border border-violet-400/20 bg-violet-400/[0.06] p-4">
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-sm font-medium text-white">Enable Ultra support</p>
          <p class="mt-1 text-xs leading-relaxed text-gray-500">Codex owns proactive delegation and sends <code class="text-gray-300">max</code> on the wire. Floway redirects that value only while Codex's active multi-agent mode is Proactive.</p>
        </div>
        <Switch v-model="draft.enabled" aria-label="Enable Codex Ultra support" />
      </div>

      <div class="mt-4 flex flex-col gap-3 border-t border-white/[0.06] pt-4 sm:flex-row sm:items-end">
        <div class="min-w-0 flex-1">
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Redirect Ultra to effort</label>
          <Input
            v-model="draft.redirectEffort"
            list="codex-ultra-effort-suggestions"
            :disabled="!draft.enabled"
            placeholder="max"
            class="w-full font-mono"
          />
          <datalist id="codex-ultra-effort-suggestions">
            <option value="low" />
            <option value="medium" />
            <option value="high" />
            <option value="xhigh" />
            <option value="max" />
          </datalist>
        </div>

        <div class="flex min-w-0 items-center gap-2 rounded-lg border border-white/[0.06] bg-surface-900 px-3 py-2.5 font-mono text-xs">
          <span class="font-semibold text-violet-300">Ultra</span>
          <i class="i-lucide-arrow-right size-3.5 shrink-0 text-gray-600" />
          <span class="truncate text-accent-cyan">{{ draft.redirectEffort || 'unset' }}</span>
        </div>
      </div>
    </div>

    <div class="mt-5 flex items-center gap-3">
      <Button :loading="saving" :disabled="draft.redirectEffort.length === 0" @click="save">Save Ultra Config</Button>
      <p class="text-xs text-gray-600">The target remains an open string so future effort levels pass through unchanged.</p>
    </div>
  </div>
</template>
