<script setup lang="ts">
// The Agent Setup card: pick which API key a setup link serves, tune each agent
// CLI's model/effort preferences, and copy the one-command installer. The card
// owns exactly one useAgentSetup lease — every control binds straight to the
// composable's draft, whose deep watcher autosaves and whose canCopy gate folds
// in sync state, lease expiry, supersession, and whether the selected key still
// exists on the account.
import { computed, useId } from 'vue';

import AgentSetupCommand from './AgentSetupCommand.vue';
import { useApi } from '../../api/client.ts';
import type { ControlPlaneModel } from '../../api/types.ts';
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

// The card needs only the identity of each key, never its secret — the raw key
// is revealed solely by the setup script the user's own machine fetches.
interface AgentSetupKey {
  id: string;
  name: string;
}

const props = withDefaults(defineProps<{
  keys: readonly AgentSetupKey[];
  models: readonly ControlPlaneModel[];
  loading?: boolean;
  error?: string | null;
}>(), { loading: false, error: null });

const api = useApi();
const setup = useAgentSetup(api, () => props.keys.map(key => key.id));
const { draft, syncing, superseded, canCopy, retryCreate } = setup;
const { initialized, noSelectableKey, error: setupError, scripts } = setup.state;

type ClaudeEffortLevel = NonNullable<AgentSetupConfiguration['claudeCode']['effortLevel']>;

const fieldIds = {
  apiKey: useId(),
  claudeModel: useId(),
  claudeSonnet: useId(),
  claudeHaiku: useId(),
  claudeEffort: useId(),
  codexModel: useId(),
  codexEffort: useId(),
};

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
  { value: SELECT_NONE, label: 'Default (agent chooses)' },
  ...claudeEffortLevels.map(value => ({ value, label: claudeEffortLabels[value] })),
];

const apiKeyOptions = computed(() => props.keys.map(key => ({ value: key.id, label: key.name })));

// A null override renders as the none-sentinel option; an unavailable restored
// id is flagged so it never looks like a normal pick.
const toSelectOptions = (options: ModelOption[]) => options.map(option => ({
  value: option.value === MODEL_OVERRIDE_NONE ? SELECT_NONE : option.value,
  label: option.modelId === null
    ? 'Default (agent chooses)'
    : option.unavailable ? `${option.modelId} (unavailable)` : option.modelId,
}));

const claudeModelOptions = computed(() => toSelectOptions(buildModelOptions(props.models, draft.value?.claudeCode.model ?? null, 'claude')));
const claudeSonnetOptions = computed(() => toSelectOptions(buildModelOptions(props.models, draft.value?.claudeCode.defaultSonnetModel ?? null, 'claude')));
const claudeHaikuOptions = computed(() => toSelectOptions(buildModelOptions(props.models, draft.value?.claudeCode.defaultHaikuModel ?? null, 'claude')));
const codexModelOptions = computed(() => toSelectOptions(buildModelOptions(props.models, draft.value?.codex.model ?? null, 'codex')));

// Codex effort suggestions come from the model whose effort is being tuned: the
// selected override if set, else the native-first Codex-family head. The value
// stays free-form — the suggestions only seed the combobox.
const codexEffortModel = computed(() => {
  const id = draft.value?.codex.model ?? null;
  if (id !== null) return props.models.find(model => model.id === id) ?? null;
  return rankAgentSetupModels(props.models, 'codex')[0] ?? null;
});
const codexEffortItems = computed(() => codexEffortSuggestions(codexEffortModel.value));

// The selects speak the none-sentinel; the draft speaks null. These proxies map
// between them and preserve a persisted [1m] value verbatim (the option value
// already carries the suffix for one-million-context Claude models).
const claudeModel = computed<string>({
  get: () => draft.value?.claudeCode.model ?? SELECT_NONE,
  set: value => { if (draft.value) draft.value.claudeCode.model = value === SELECT_NONE ? null : value; },
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

const origin = window.location.origin;
const shellCommand = computed(() => (scripts.value ? `curl -fsSL ${origin}${scripts.value.sh} | bash` : ''));
const powerShellCommand = computed(() => (scripts.value ? `irm ${origin}${scripts.value.ps1} | iex` : ''));
const copyDisabled = computed(() => !canCopy.value);
</script>

<template>
  <section class="glass-card p-5 sm:p-6 animate-in delay-1">
    <div class="mb-5 flex items-center justify-between gap-3">
      <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Agent Setup</span>
      <span v-if="syncing" class="inline-flex items-center gap-1.5 text-xs text-gray-500">
        <Spinner class="size-3.5" />
        Saving…
      </span>
    </div>

    <div v-if="superseded" class="rounded-lg border border-accent-amber/40 bg-accent-amber/10 px-4 py-3 text-sm text-accent-amber">
      This setup session was taken over by another tab or device. Reload the page to continue.
    </div>

    <div v-else-if="noSelectableKey" class="rounded-lg border border-white/10 bg-surface-800/60 px-4 py-6 text-center text-sm text-gray-400">
      Create an API key above to generate one-command agent setup.
    </div>

    <div v-else-if="!initialized && setupError" data-testid="agent-setup-create-error" class="rounded-lg border border-accent-rose/40 bg-accent-rose/10 px-4 py-4 text-sm text-accent-rose">
      <p>Could not prepare agent setup: {{ setupError }}</p>
      <Button variant="secondary" size="sm" class="mt-3" @click="retryCreate">
        <i class="i-lucide-refresh-cw size-3.5" />
        Retry
      </Button>
    </div>

    <div v-else-if="!initialized" class="flex items-center gap-2 px-1 py-6 text-sm text-gray-500">
      <Spinner class="size-4" />
      Preparing setup…
    </div>

    <template v-else-if="draft">
      <div v-if="setupError ?? error" class="mb-4 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
        {{ setupError ?? error }}
      </div>

      <div class="mb-6" data-testid="agent-setup-api-key">
        <label :for="fieldIds.apiKey" class="mb-1.5 block text-xs text-gray-500">API key</label>
        <Select :id="fieldIds.apiKey" v-model="draft.apiKeyId" :options="apiKeyOptions" placeholder="Select an API key" />
        <p class="mt-1.5 text-[11px] text-gray-600">
          The generated commands carry this key. Anyone with the setup link can read it — keep the link private.
        </p>
      </div>

      <p v-if="loading && models.length === 0" class="mb-4 text-[11px] text-gray-500">Loading models…</p>

      <div class="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <div>
          <div class="mb-3 flex items-center justify-between">
            <span class="text-sm font-semibold text-white">Claude Code</span>
            <Switch v-model="draft.claudeCode.enabled" aria-label="Enable Claude Code setup" />
          </div>
          <div class="space-y-3" :class="{ 'opacity-60': !draft.claudeCode.enabled }">
            <div data-testid="claude-model">
              <label :for="fieldIds.claudeModel" class="mb-1.5 block text-xs text-gray-500">Model</label>
              <Select :id="fieldIds.claudeModel" v-model="claudeModel" :options="claudeModelOptions" :disabled="!draft.claudeCode.enabled" />
            </div>
            <div data-testid="claude-sonnet">
              <label :for="fieldIds.claudeSonnet" class="mb-1.5 block text-xs text-gray-500">Sonnet alias</label>
              <Select :id="fieldIds.claudeSonnet" v-model="claudeSonnetModel" :options="claudeSonnetOptions" :disabled="!draft.claudeCode.enabled" />
            </div>
            <div data-testid="claude-haiku">
              <label :for="fieldIds.claudeHaiku" class="mb-1.5 block text-xs text-gray-500">Haiku alias</label>
              <Select :id="fieldIds.claudeHaiku" v-model="claudeHaikuModel" :options="claudeHaikuOptions" :disabled="!draft.claudeCode.enabled" />
            </div>
            <div data-testid="claude-effort">
              <label :for="fieldIds.claudeEffort" class="mb-1.5 block text-xs text-gray-500">Reasoning effort</label>
              <Select :id="fieldIds.claudeEffort" v-model="claudeEffort" :options="claudeEffortOptions" :disabled="!draft.claudeCode.enabled" />
            </div>
            <div class="flex items-center justify-between pt-1">
              <span class="text-xs text-gray-500">Gateway model discovery</span>
              <Switch
                v-model="draft.claudeCode.modelDiscovery"
                aria-label="Enable Claude Code gateway model discovery"
                :disabled="!draft.claudeCode.enabled"
              />
            </div>
          </div>
        </div>

        <div>
          <div class="mb-3 flex items-center justify-between">
            <span class="text-sm font-semibold text-white">Codex</span>
            <Switch v-model="draft.codex.enabled" aria-label="Enable Codex setup" />
          </div>
          <div class="space-y-3" :class="{ 'opacity-60': !draft.codex.enabled }">
            <div data-testid="codex-model">
              <label :for="fieldIds.codexModel" class="mb-1.5 block text-xs text-gray-500">Model</label>
              <Select :id="fieldIds.codexModel" v-model="codexModel" :options="codexModelOptions" :disabled="!draft.codex.enabled" />
            </div>
            <div data-testid="codex-effort">
              <label :for="fieldIds.codexEffort" class="mb-1.5 block text-xs text-gray-500">Reasoning effort</label>
              <Combobox
                :id="fieldIds.codexEffort"
                v-model="codexEffort"
                :items="codexEffortItems"
                :disabled="!draft.codex.enabled"
                placeholder="Model default"
                input-class="font-mono"
                empty-text="No suggested presets"
              />
            </div>
            <p v-if="draft.codex.enabled" class="text-[11px] text-accent-amber/90">
              Running the Codex command replaces the ChatGPT login in <code class="text-accent-amber">CODEX_HOME/auth.json</code>; a timestamped backup is written first.
            </p>
          </div>
        </div>
      </div>

      <div class="mt-6 space-y-4">
        <p class="text-[11px] text-gray-600">
          These commands install the selected agents and point them at this gateway. The setup link refreshes automatically while this page stays open and expires a few minutes after you leave.
        </p>
        <AgentSetupCommand label="macOS · Linux · WSL" :command="shellCommand" language="bash" :disabled="copyDisabled" />
        <AgentSetupCommand label="Windows PowerShell" :command="powerShellCommand" language="text" :disabled="copyDisabled" />
      </div>
    </template>
  </section>
</template>
