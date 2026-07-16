<script setup lang="ts">
// The Agent Setup card: pick which API key a setup link serves, tune each agent
// CLI's model/effort preferences, and copy the one-command installer. The card
// owns exactly one useAgentSetup lease — every control binds straight to the
// composable's draft, whose deep watcher autosaves and whose canCopy gate folds
// in sync state, lease expiry, supersession, and whether the selected key still
// exists on the account.
import { computed, shallowRef, useId } from 'vue';

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
  keys: readonly ApiKey[];
  models: readonly ControlPlaneModel[];
  loading?: boolean;
  error?: string | null;
}>(), { loading: false, error: null });

const api = useApi();
const setup = useAgentSetup(api, () => props.keys.map(key => key.id));
const { draft, syncing, terminated, canCopy, retryCreate } = setup;
const { initialized, noSelectableKey, error: setupError, scripts } = setup.state;

type AgentSetupView = 'agent-setup' | 'config-snippets';
const activeView = shallowRef<AgentSetupView>('agent-setup');
const commandPlatform = shallowRef<AgentSetupPlatform>(detectAgentSetupPlatform(navigator.platform, navigator.userAgent));

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
  { value: SELECT_NONE, label: 'Default' },
  ...claudeEffortLevels.map(value => ({ value, label: claudeEffortLabels[value] })),
];

const apiKeyOptions = computed(() => props.keys.map(key => ({ value: key.id, label: key.name })));

// A null override renders as the none-sentinel option; an unavailable restored
// id is flagged so it never looks like a normal pick.
const toSelectOptions = (options: ModelOption[]) => options.map(option => ({
  value: option.value === MODEL_OVERRIDE_NONE ? SELECT_NONE : option.value,
  label: option.modelId === null
    ? 'Default'
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

// The gateway never learns its own public origin, so each command injects this
// dashboard's origin into the shell that runs the fetched installer and points
// the fetch at that same variable — the origin literal appears exactly once.
// URL origin syntax excludes single quotes, but both commands still encode the
// value as a single-quoted literal rather than making safety depend on that URL
// invariant (POSIX uses close/backslash/reopen; PowerShell doubles the quote).
const origin = window.location.origin;
const shellCommand = computed(() => (scripts.value
  ? `export FLOWAY_BASE_URL='${origin.replace(/'/g, "'\\''")}'; curl -fsSL "$FLOWAY_BASE_URL${scripts.value.sh}" | bash`
  : ''));
const powerShellCommand = computed(() => (scripts.value
  ? `$FlowayBaseUrl = '${origin.replace(/'/g, "''")}'; irm "$FlowayBaseUrl${scripts.value.ps1}" | iex`
  : ''));
</script>

<template>
  <section class="glass-card p-5 sm:p-6 animate-in delay-1">
    <div class="mb-5 flex items-center justify-between gap-3">
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
      <span v-if="activeView === 'agent-setup' && syncing" class="inline-flex items-center gap-1.5 text-xs text-gray-500">
        <Spinner class="size-3.5" />
        Saving…
      </span>
    </div>

    <AgentConfigSnippets v-if="activeView === 'config-snippets'" :keys="keys" :models="models" />

    <template v-else>
    <div v-if="terminated" class="rounded-lg border border-accent-amber/40 bg-accent-amber/10 px-4 py-3 text-sm text-accent-amber">
      This setup link has expired and is no longer valid. Reload the page to get a fresh link.
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

      <div class="mb-8 max-w-sm" data-testid="agent-setup-api-key">
        <label :for="fieldIds.apiKey" class="mb-1.5 block text-xs text-gray-500">API key</label>
        <Select :id="fieldIds.apiKey" v-model="draft.apiKeyId" :options="apiKeyOptions" placeholder="Select an API key" />
        <p class="mt-1.5 text-[11px] text-gray-600">
          The generated commands carry this key. Anyone with the setup link can read it — keep the link private.
        </p>
      </div>

      <p v-if="loading && models.length === 0" class="mb-4 text-[11px] text-gray-500">Loading models…</p>

      <div class="space-y-8">
        <section>
          <div class="mb-4 flex items-center gap-2">
            <Switch v-model="draft.claudeCode.enabled" aria-label="Enable Claude Code setup" />
            <h3 class="text-sm font-semibold text-white">Claude Code</h3>
          </div>
          <div v-if="draft.claudeCode.enabled" class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <div data-testid="claude-model">
              <label :for="fieldIds.claudeModel" class="mb-1.5 block text-xs text-gray-500">Model</label>
              <Select :id="fieldIds.claudeModel" v-model="claudeModel" :options="claudeModelOptions" />
            </div>
            <div data-testid="claude-sonnet">
              <label :for="fieldIds.claudeSonnet" class="mb-1.5 block text-xs text-gray-500">Sonnet alias</label>
              <Select :id="fieldIds.claudeSonnet" v-model="claudeSonnetModel" :options="claudeSonnetOptions" />
            </div>
            <div data-testid="claude-haiku">
              <label :for="fieldIds.claudeHaiku" class="mb-1.5 block text-xs text-gray-500">Haiku alias</label>
              <Select :id="fieldIds.claudeHaiku" v-model="claudeHaikuModel" :options="claudeHaikuOptions" />
            </div>
            <div data-testid="claude-effort">
              <label :for="fieldIds.claudeEffort" class="mb-1.5 block text-xs text-gray-500">Reasoning effort</label>
              <Select :id="fieldIds.claudeEffort" v-model="claudeEffort" :options="claudeEffortOptions" />
            </div>
            <div class="flex min-h-14 items-center justify-between gap-3 rounded-lg border border-white/10 bg-surface-800 px-3 py-2">
              <span class="text-xs text-gray-500">Gateway model discovery</span>
              <Switch v-model="draft.claudeCode.modelDiscovery" aria-label="Enable Claude Code gateway model discovery" />
            </div>
          </div>
        </section>

        <section class="border-t border-white/5 pt-8">
          <div class="mb-4 flex items-center gap-2">
            <Switch v-model="draft.codex.enabled" aria-label="Enable Codex setup" />
            <h3 class="text-sm font-semibold text-white">Codex</h3>
          </div>
          <div v-if="draft.codex.enabled">
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
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

      <div class="mt-8 border-t border-white/5 pt-6">
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

        <div class="mt-4">
          <AgentSetupCommand
            v-if="commandPlatform === 'unix'"
            label="macOS / Linux"
            :command="shellCommand"
            language="bash"
            :disabled="!canCopy"
            :show-label="false"
          />
          <AgentSetupCommand
            v-else
            label="Windows"
            :command="powerShellCommand"
            language="text"
            :disabled="!canCopy"
            :show-label="false"
          />
        </div>

        <p class="mt-4 text-[11px] text-gray-600">
          These commands install the selected agents and point them at this gateway. The setup link refreshes automatically while this page stays open and expires a few minutes after you leave.
        </p>
      </div>
    </template>
    </template>
  </section>
</template>
