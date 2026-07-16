<script setup lang="ts">
// The Agent Setup card keeps one stable form while the table selection changes.
// Before a key is selected, edits live only in the local draft; selecting a key
// acquires a lease and transfers those choices into the server-backed draft.
// Later key changes update that lease in place, so neither the form nor its URL
// remounts.
import { computed, ref, shallowRef, useId, watch } from 'vue';

import { detectAgentSetupPlatform, type AgentSetupPlatform } from './agent-setup-platform.ts';
import AgentConfigSnippets from './AgentConfigSnippets.vue';
import AgentSetupCommand from './AgentSetupCommand.vue';
import { useApi } from '../../api/client.ts';
import type { ApiKey, ControlPlaneModel } from '../../api/types.ts';
import { type AgentSetupConfiguration, useAgentSetup } from '../../composables/useAgentSetup.ts';
import {
  buildModelOptions,
  codexEffortSuggestions,
  MODEL_OVERRIDE_NONE,
  type ModelOption,
  normalizeEffortInput,
  rankAgentSetupModels,
} from '../../lib/agent-setup-models.ts';
import { Combobox, Button, Select, Spinner, Switch } from '@floway-dev/ui';

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

const localDraft = ref<AgentSetupConfiguration>({
  apiKeyId: '',
  claudeCode: {
    enabled: true,
    model: null,
    defaultOpusModel: null,
    defaultSonnetModel: null,
    defaultHaikuModel: null,
    effortLevel: null,
    modelDiscovery: true,
  },
  codex: { enabled: true, model: null, reasoningEffort: null },
});
let localDraftEdited = false;
watch(localDraft, () => { localDraftEdited = true; }, { deep: true });

const draft = computed(() => props.selectedKey !== null && serverDraft.value !== null
  ? serverDraft.value
  : localDraft.value);

type AgentSetupView = 'agent-setup' | 'config-snippets';
const activeView = shallowRef<AgentSetupView>('agent-setup');
const commandPlatform = shallowRef<AgentSetupPlatform>(detectAgentSetupPlatform(navigator.platform, navigator.userAgent));

type ClaudeEffortLevel = NonNullable<AgentSetupConfiguration['claudeCode']['effortLevel']>;

const fieldIds = {
  claudeModel: useId(),
  claudeOpus: useId(),
  claudeSonnet: useId(),
  claudeHaiku: useId(),
  claudeEffort: useId(),
  codexModel: useId(),
  codexEffort: useId(),
};
const agentFieldGridClass = 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5';

watch([serverDraft, () => props.selectedKey?.id ?? null], ([configuration, selectedKeyId]) => {
  if (configuration !== null && selectedKeyId !== null) {
    if (localDraftEdited) {
      configuration.claudeCode = { ...localDraft.value.claudeCode };
      configuration.codex = { ...localDraft.value.codex };
      localDraftEdited = false;
    }
    if (configuration.apiKeyId !== selectedKeyId) configuration.apiKeyId = selectedKeyId;
  }
}, { immediate: true });

// Reka's Select reserves the empty string for "cleared" and rejects it as an
// option value, but the model helpers' "no override" sentinel IS the empty
// string. The Select layer swaps in a NUL-prefixed token: the agent-setup
// configuration schema rejects NUL in every opaque model / effort field, so this
// token can never collide with a real persisted value.
const SELECT_NONE = '\u0000none';

// Claude Code's reasoning-effort control is a closed Floway-side enum (see the
// agent-setup configuration schema), not an upstream-owned protocol slot, so its
// options are enumerated here rather than read from a model's capabilities.
const claudeEffortLevels = ['low', 'medium', 'high', 'xhigh'] as const satisfies readonly ClaudeEffortLevel[];
const claudeEffortLabels = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
} satisfies Record<ClaudeEffortLevel, string>;
const isClaudeEffortLevel = (value: string): value is ClaudeEffortLevel =>
  claudeEffortLevels.some(level => level === value);
const normalizeClaudeEffort = (value: string): ClaudeEffortLevel | null => {
  if (value === SELECT_NONE) return null;
  if (isClaudeEffortLevel(value)) return value;
  throw new Error(`Unexpected Claude effort option: ${value}`);
};
const claudeEffortOptions: { value: string; label: string }[] = [
  { value: SELECT_NONE, label: 'Default' },
  ...claudeEffortLevels.map(value => ({ value, label: claudeEffortLabels[value] })),
];

// A null override renders as the none-sentinel option; an unavailable restored
// id is flagged so it never looks like a normal pick.
const toSelectOptions = (options: ModelOption[]) => options.map(option => ({
  value: option.value === MODEL_OVERRIDE_NONE ? SELECT_NONE : option.value,
  label: option.modelId === null
    ? 'Default'
    : option.unavailable ? `${option.modelId} (unavailable)` : option.modelId,
}));

const claudeModelOptions = computed(() => toSelectOptions(buildModelOptions(props.models, draft.value?.claudeCode.model ?? null, { family: 'claude', picker: 'default' })));
const claudeOpusOptions = computed(() => toSelectOptions(buildModelOptions(props.models, draft.value?.claudeCode.defaultOpusModel ?? null, { family: 'claude', picker: 'opus' })));
const claudeSonnetOptions = computed(() => toSelectOptions(buildModelOptions(props.models, draft.value?.claudeCode.defaultSonnetModel ?? null, { family: 'claude', picker: 'sonnet' })));
const claudeHaikuOptions = computed(() => toSelectOptions(buildModelOptions(props.models, draft.value?.claudeCode.defaultHaikuModel ?? null, { family: 'claude', picker: 'haiku' })));
const codexModelOptions = computed(() => toSelectOptions(buildModelOptions(props.models, draft.value?.codex.model ?? null, { family: 'codex' })));

// Codex effort suggestions come from the model whose effort is being tuned: the
// selected override if set, else the native-first Codex-family head. The value
// stays free-form — the suggestions only seed the combobox.
const codexEffortModel = computed(() => {
  const id = draft.value?.codex.model ?? null;
  if (id !== null) return props.models.find(model => model.id === id) ?? null;
  return rankAgentSetupModels(props.models, { family: 'codex' })[0] ?? null;
});
const codexEffortItems = computed(() => codexEffortSuggestions(codexEffortModel.value));

// The selects speak the none-sentinel; the draft speaks null. These proxies map
// between them and preserve a persisted [1m] value verbatim (the option value
// already carries the suffix for one-million-context Claude models).
const claudeModel = computed<string>({
  get: () => draft.value?.claudeCode.model ?? SELECT_NONE,
  set: value => { if (draft.value) draft.value.claudeCode.model = value === SELECT_NONE ? null : value; },
});
const claudeOpusModel = computed<string>({
  get: () => draft.value?.claudeCode.defaultOpusModel ?? SELECT_NONE,
  set: value => { if (draft.value) draft.value.claudeCode.defaultOpusModel = value === SELECT_NONE ? null : value; },
});
const claudeSonnetModel = computed<string>({
  get: () => draft.value?.claudeCode.defaultSonnetModel ?? SELECT_NONE,
  set: value => { if (draft.value) draft.value.claudeCode.defaultSonnetModel = value === SELECT_NONE ? null : value; },
});
const claudeHaikuModel = computed<string>({
  get: () => draft.value?.claudeCode.defaultHaikuModel ?? SELECT_NONE,
  set: value => { if (draft.value) draft.value.claudeCode.defaultHaikuModel = value === SELECT_NONE ? null : value; },
});
const claudeEffort = computed<string>({
  get: () => draft.value?.claudeCode.effortLevel ?? SELECT_NONE,
  set: value => { if (draft.value) draft.value.claudeCode.effortLevel = normalizeClaudeEffort(value); },
});
const codexModel = computed<string>({
  get: () => draft.value?.codex.model ?? SELECT_NONE,
  set: value => { if (draft.value) draft.value.codex.model = value === SELECT_NONE ? null : value; },
});
// Codex effort is a free-form combobox, not a Select, so the empty string it
// yields on clear maps cleanly to null while any opaque non-empty value survives.
const codexEffort = computed<string>({
  get: () => draft.value?.codex.reasoningEffort ?? '',
  set: value => { if (draft.value) draft.value.codex.reasoningEffort = normalizeEffortInput(value); },
});

// The gateway never learns its own public origin, so each command injects this
// dashboard's origin into the shell that runs the fetched installer and points
// the fetch at that same variable — the origin literal appears exactly once.
// URL origin syntax excludes single quotes, but both commands still encode the
// value as a single-quoted literal rather than making safety depend on that URL
// invariant (POSIX uses close/backslash/reopen; PowerShell doubles the quote).
const origin = window.location.origin;
const shellCommand = computed(() => (scripts.value
  && props.selectedKey !== null
  ? `export FLOWAY_BASE_URL='${origin.replace(/'/g, "'\\''")}'; curl -fsSL "$FLOWAY_BASE_URL${scripts.value.sh}" | bash`
  : props.selectedKey === null ? '# Select an API key above to generate the setup command.' : '# Preparing setup command…'));
const powerShellCommand = computed(() => (scripts.value
  && props.selectedKey !== null
  ? `$FlowayBaseUrl = '${origin.replace(/'/g, "''")}'; irm "$FlowayBaseUrl${scripts.value.ps1}" | iex`
  : props.selectedKey === null ? '# Select an API key above to generate the setup command.' : '# Preparing setup command…'));
</script>

<template>
  <section class="glass-card p-5 sm:p-6 animate-in delay-1">
    <div class="mb-5 flex items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Agent configuration mode" class="inline-flex items-center gap-1 rounded-lg bg-surface-800 p-0.5">
          <button
            v-for="view in (['agent-setup', 'config-snippets'] as const)"
            :key="view"
            role="tab"
            class="rounded-md px-3 py-1.5 text-xs font-medium transition-all"
            :class="activeView === view ? 'bg-surface-600 text-white' : 'text-gray-500 hover:text-gray-300'"
            :aria-selected="activeView === view"
            @click="activeView = view"
          >{{ view === 'agent-setup' ? 'Agent Setup' : 'Config snippets' }}</button>
        </div>
        <p class="text-xs" :class="selectedKey === null ? 'text-gray-500' : 'font-medium text-gray-300'">
          {{ selectedKey === null ? 'Select the API key to use.' : `The configuration below will use the ${selectedKey.name} API key.` }}
        </p>
      </div>
      <span v-if="activeView === 'agent-setup' && syncing" class="inline-flex items-center gap-1.5 text-xs text-gray-500">
        <Spinner class="size-3.5" />
        Saving…
      </span>
    </div>

    <AgentConfigSnippets v-if="activeView === 'config-snippets' && selectedKey !== null" :api-key="selectedKey" :models="models" />

    <div v-else-if="activeView === 'config-snippets'" class="rounded-lg border border-white/10 bg-surface-800/60 px-4 py-6 text-center text-sm text-gray-400">
      Select an API key above to generate configuration snippets.
    </div>

    <template v-else>
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

      <div v-if="setupError ?? error" class="mb-4 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
        {{ setupError ?? error }}
      </div>

      <p v-if="loading && models.length === 0" class="mb-4 text-[11px] text-gray-500">Loading models…</p>

      <div class="space-y-5">
        <section>
          <div class="mb-4 flex items-center gap-2">
            <Switch v-model="draft.claudeCode.enabled" aria-label="Enable Claude Code setup" />
            <h3 class="text-sm font-semibold text-white">Claude Code</h3>
          </div>
          <div v-if="draft.claudeCode.enabled" data-testid="claude-fields" :class="agentFieldGridClass">
            <div data-testid="claude-model">
              <label :for="fieldIds.claudeModel" class="mb-1.5 block text-xs text-gray-500">Default model</label>
              <Select :id="fieldIds.claudeModel" v-model="claudeModel" :options="claudeModelOptions" />
            </div>
            <div data-testid="claude-opus">
              <label :for="fieldIds.claudeOpus" class="mb-1.5 block text-xs text-gray-500">Opus model</label>
              <Select :id="fieldIds.claudeOpus" v-model="claudeOpusModel" :options="claudeOpusOptions" />
            </div>
            <div data-testid="claude-sonnet">
              <label :for="fieldIds.claudeSonnet" class="mb-1.5 block text-xs text-gray-500">Sonnet model</label>
              <Select :id="fieldIds.claudeSonnet" v-model="claudeSonnetModel" :options="claudeSonnetOptions" />
            </div>
            <div data-testid="claude-haiku">
              <label :for="fieldIds.claudeHaiku" class="mb-1.5 block text-xs text-gray-500">Haiku model</label>
              <Select :id="fieldIds.claudeHaiku" v-model="claudeHaikuModel" :options="claudeHaikuOptions" />
            </div>
            <div data-testid="claude-effort">
              <label :for="fieldIds.claudeEffort" class="mb-1.5 block text-xs text-gray-500">Reasoning effort</label>
              <Select :id="fieldIds.claudeEffort" v-model="claudeEffort" :options="claudeEffortOptions" />
            </div>
            <div data-testid="claude-model-discovery">
              <span class="mb-1.5 block text-xs text-gray-500">Gateway model discovery</span>
              <div class="flex h-9 items-center gap-2">
                <Switch v-model="draft.claudeCode.modelDiscovery" size="sm" aria-label="Enable Claude Code gateway model discovery" />
                <span class="text-sm text-white">{{ draft.claudeCode.modelDiscovery ? 'Enabled' : 'Disabled' }}</span>
              </div>
            </div>
          </div>
        </section>

        <section class="border-t border-white/5 pt-5">
          <div class="mb-4 flex items-center gap-2">
            <Switch v-model="draft.codex.enabled" aria-label="Enable Codex setup" />
            <h3 class="text-sm font-semibold text-white">Codex</h3>
          </div>
          <div v-if="draft.codex.enabled">
            <div data-testid="codex-fields" :class="agentFieldGridClass">
              <div data-testid="codex-model">
                <label :for="fieldIds.codexModel" class="mb-1.5 block text-xs text-gray-500">Model</label>
                <Select :id="fieldIds.codexModel" v-model="codexModel" :options="codexModelOptions" />
              </div>
              <div data-testid="codex-effort">
                <label :for="fieldIds.codexEffort" class="mb-1.5 block text-xs text-gray-500">Reasoning effort</label>
                <Combobox
                  :id="fieldIds.codexEffort"
                  v-model="codexEffort"
                  :items="codexEffortItems"
                  placeholder="Model default"
                  input-class="font-mono"
                  empty-text="No suggested presets"
                />
              </div>
            </div>
            <p class="mt-3 text-[11px] text-gray-500">
              The Floway provider token is stored separately under <code class="text-gray-400">CODEX_HOME</code>; an official Codex account login remains available.
            </p>
          </div>
        </section>
      </div>

      <div class="mt-6 border-t border-white/5 pt-5">
        <AgentSetupCommand
          :label="commandPlatform === 'unix' ? 'macOS / Linux' : 'Windows'"
          :command="commandPlatform === 'unix' ? shellCommand : powerShellCommand"
          :language="commandPlatform === 'unix' ? 'bash' : 'powershell'"
          :disabled="selectedKey === null || !canCopy"
          :show-label="false"
        >
          <template #header>
            <div role="tablist" aria-label="Setup command platform" class="inline-flex items-center gap-1 rounded-lg bg-surface-800 p-0.5">
              <button
                v-for="platform in (['unix', 'windows'] as const)"
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
          These commands install the selected agents and point them at this gateway. The setup link refreshes automatically while this page stays open and expires a few minutes after you leave.
        </p>
      </div>
    </template>
  </section>
</template>
