<script setup lang="ts">
// The card owns one configuration form and switches only the generated output.
// Before a key is selected, edits stay in a local draft; selecting a key applies
// only those edited fields to the server-restored configuration.
import { computed, ref, shallowRef, watch } from 'vue';

import { AGENT_SETUP_PLATFORMS, detectAgentSetupPlatform } from './agent-setup-platform.ts';
import AgentConfigSnippets from './AgentConfigSnippets.vue';
import AgentConfigurationFields, { type ConfigurationPatch } from './AgentConfigurationFields.vue';
import AgentSetupCommand from './AgentSetupCommand.vue';
import { useApi } from '../../api/client.ts';
import type { ApiKey, ControlPlaneModel } from '../../api/types.ts';
import { type AgentSetupConfiguration, useAgentSetup } from '../../composables/useAgentSetup.ts';
import { Button, Spinner } from '@floway-dev/ui';

const props = withDefaults(defineProps<{
  selectedKey: ApiKey | null;
  models: readonly ControlPlaneModel[];
  loading?: boolean;
  error?: string | null;
}>(), { loading: false, error: null });

const api = useApi();
const setup = useAgentSetup(
  api,
  () => props.selectedKey === null ? [] : [props.selectedKey.id],
  () => props.selectedKey !== null,
);
const { draft: serverDraft, syncing, terminated, canCopy, retryCreate } = setup;
const { initialized, noSelectableKey, error: setupError, scripts } = setup.state;

const cloneConfiguration = (configuration: AgentSetupConfiguration): AgentSetupConfiguration => ({
  apiKeyId: configuration.apiKeyId,
  claudeCode: { ...configuration.claudeCode },
  codex: { ...configuration.codex },
});
const copyChangedFields = <T extends object>(target: T, current: T, baseline: T) => {
  for (const key of Object.keys(current) as (keyof T)[]) {
    if (!Object.is(current[key], baseline[key])) target[key] = current[key];
  }
};

const localDraft = ref<AgentSetupConfiguration>({
  apiKeyId: '',
  claudeCode: {
    model: null,
    defaultOpusModel: null,
    defaultSonnetModel: null,
    defaultHaikuModel: null,
    effortLevel: null,
    modelDiscovery: true,
  },
  codex: { model: null, reasoningEffort: null },
});
let localDraftBaseline = cloneConfiguration(localDraft.value);
const draft = computed<AgentSetupConfiguration>({
  get: () => props.selectedKey !== null && serverDraft.value !== null
    ? serverDraft.value
    : localDraft.value,
  set: configuration => {
    if (props.selectedKey !== null && serverDraft.value !== null) serverDraft.value = configuration;
    else localDraft.value = configuration;
  },
});
const updateConfiguration = (patch: ConfigurationPatch) => {
  draft.value = {
    ...draft.value,
    claudeCode: patch.claudeCode === undefined
      ? draft.value.claudeCode
      : { ...draft.value.claudeCode, ...patch.claudeCode },
    codex: patch.codex === undefined
      ? draft.value.codex
      : { ...draft.value.codex, ...patch.codex },
  };
};

watch([serverDraft, () => props.selectedKey?.id ?? null], ([configuration, selectedKeyId]) => {
  if (configuration === null || selectedKeyId === null) return;
  copyChangedFields(configuration.claudeCode, localDraft.value.claudeCode, localDraftBaseline.claudeCode);
  copyChangedFields(configuration.codex, localDraft.value.codex, localDraftBaseline.codex);
  localDraftBaseline = cloneConfiguration(localDraft.value);
  if (configuration.apiKeyId !== selectedKeyId) configuration.apiKeyId = selectedKeyId;
}, { immediate: true });

type AgentSetupView = 'agent-setup' | 'config-snippets';
type SetupAgent = 'claude' | 'codex';
const activeView = shallowRef<AgentSetupView>('agent-setup');
const activeAgent = shallowRef<SetupAgent>('claude');
const commandPlatform = shallowRef(detectAgentSetupPlatform(navigator.platform, navigator.userAgent));
const visibleError = computed(() => activeView.value === 'config-snippets'
  ? props.error
  : initialized.value ? setupError.value ?? props.error : props.error);

// The gateway never learns its own public origin, so each command injects this
// dashboard's origin into the shell that runs the fetched installer.
const origin = window.location.origin;
const activeScripts = computed(() => scripts.value?.[activeAgent.value] ?? null);
const agentLabel = (agent: SetupAgent) => agent === 'claude' ? 'Claude Code' : 'Codex';
const activeAgentLabel = computed(() => agentLabel(activeAgent.value));
const commandPlaceholder = computed(() => props.selectedKey === null
  ? '# Select an API key above to generate the setup command.'
  : '# Preparing setup command…');
const shellCommand = computed(() => activeScripts.value && props.selectedKey !== null
  ? `export SETUP_ENDPOINT='${origin.replace(/'/g, "'\\''")}'; curl -fsSL "$SETUP_ENDPOINT${activeScripts.value.sh}" | bash`
  : commandPlaceholder.value);
const powerShellCommand = computed(() => activeScripts.value && props.selectedKey !== null
  ? `$SetupEndpoint = '${origin.replace(/'/g, "''")}'; irm "$SetupEndpoint${activeScripts.value.ps1}" | iex`
  : commandPlaceholder.value);
</script>

<template>
  <section class="glass-card p-5 sm:p-6 animate-in delay-1">
    <div class="grid gap-5 md:grid-cols-[max-content_minmax(0,1fr)]">
      <aside class="space-y-4">
        <div role="tablist" aria-label="Agent configuration mode" class="inline-flex items-center gap-1 rounded-lg bg-surface-800 p-0.5">
          <button
            v-for="view in (['agent-setup', 'config-snippets'] as const)"
            :key="view"
            role="tab"
            class="shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-all"
            :class="activeView === view ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
            :aria-selected="activeView === view"
            @click="activeView = view"
          >{{ view === 'agent-setup' ? 'Agent Setup' : 'Config snippets' }}</button>
        </div>

        <nav aria-label="Agent" class="flex flex-col gap-2 border-t border-white/5 pt-4">
          <button
            v-for="agent in (['claude', 'codex'] as const)"
            :key="agent"
            class="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors"
            :class="activeAgent === agent ? 'bg-surface-700 text-white' : 'text-gray-500 hover:bg-white/[0.03] hover:text-gray-300'"
            :aria-current="activeAgent === agent ? 'true' : undefined"
            @click="activeAgent = agent"
          >
            <i :class="agent === 'claude' ? 'i-simple-icons-anthropic' : 'i-simple-icons-openai'" class="size-4 shrink-0" />
            {{ agentLabel(agent) }}
          </button>
        </nav>
      </aside>

      <div class="min-w-0">
        <div class="mb-5 flex min-h-10 items-center justify-between gap-3">
          <p class="text-xs text-gray-600">
            <template v-if="selectedKey === null">Select the API key to use.</template>
            <template v-else>The configuration below will use the <span class="font-medium text-gray-300">{{ selectedKey.name }}</span> API key.</template>
          </p>
          <span v-if="activeView === 'agent-setup' && syncing" class="inline-flex items-center gap-1.5 text-xs text-gray-500">
            <Spinner class="size-3.5" />
            Saving…
          </span>
        </div>

        <template v-if="activeView === 'agent-setup'">
          <div v-if="selectedKey !== null && terminated" class="mb-4 rounded-lg border border-accent-amber/40 bg-accent-amber/10 px-4 py-3 text-sm text-accent-amber">
            This setup link has expired and is no longer valid. Reload the page to get a fresh link.
          </div>

          <div v-if="selectedKey !== null && noSelectableKey" class="mb-4 rounded-lg border border-white/10 bg-surface-800/60 px-4 py-3 text-sm text-gray-400">
            Create an API key above to generate one-command agent setup.
          </div>

          <div v-if="selectedKey !== null && !initialized && setupError" data-testid="agent-setup-create-error" class="mb-4 rounded-lg border border-accent-rose/40 bg-accent-rose/10 px-4 py-4 text-sm text-accent-rose">
            <p>Could not prepare agent setup: {{ setupError }}</p>
            <Button variant="secondary" size="sm" class="mt-3" @click="retryCreate">
              <i class="i-lucide-refresh-cw size-3.5" />
              Retry
            </Button>
          </div>

          <div v-if="selectedKey !== null && !initialized && !setupError" class="mb-4 flex items-center gap-2 px-1 text-sm text-gray-500">
            <Spinner class="size-4" />
            Preparing setup…
          </div>
        </template>

        <div v-if="visibleError" class="mb-4 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
          {{ visibleError }}
        </div>
        <p v-if="loading && models.length === 0" class="mb-4 text-[11px] text-gray-500">Loading models…</p>

        <AgentConfigurationFields :agent="activeAgent" :models="models" :configuration="draft" @update="updateConfiguration" />

        <AgentConfigSnippets
          v-if="activeView === 'config-snippets' && selectedKey !== null"
          :agent="activeAgent"
          :api-key="selectedKey"
          :configuration="draft"
        />
        <div v-else-if="activeView === 'config-snippets'" class="mt-5 rounded-lg border border-white/10 bg-surface-800/60 px-4 py-6 text-center text-sm text-gray-400">
          Select an API key above to generate configuration snippets.
        </div>

        <div v-else class="mt-5 border-t border-white/5 pt-5">
          <AgentSetupCommand
            :label="commandPlatform === 'unix' ? 'macOS / Linux' : 'Windows'"
            :command="commandPlatform === 'unix' ? shellCommand : powerShellCommand"
            :language="commandPlatform === 'unix' ? 'bash' : 'powershell'"
            :disabled="selectedKey === null || !canCopy"
          >
            <template #header>
              <div role="tablist" aria-label="Setup command platform" class="inline-flex items-center gap-1 rounded-lg bg-surface-800 p-0.5">
                <button
                  v-for="platform in AGENT_SETUP_PLATFORMS"
                  :key="platform"
                  role="tab"
                  class="rounded-md px-3 py-1.5 text-xs font-medium transition-all"
                  :class="commandPlatform === platform ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
                  :aria-selected="commandPlatform === platform"
                  @click="commandPlatform = platform"
                >{{ platform === 'unix' ? 'macOS / Linux' : 'Windows' }}</button>
              </div>
            </template>
          </AgentSetupCommand>

          <p class="mt-4 text-[11px] text-gray-600">
            This command installs and configures {{ activeAgentLabel }}. The setup link refreshes automatically while this page stays open and expires a few minutes after you leave.
          </p>
        </div>
      </div>
    </div>
  </section>
</template>
