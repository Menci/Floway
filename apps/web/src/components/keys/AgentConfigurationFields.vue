<script setup lang="ts">
import { computed, useId } from 'vue';

import type { ControlPlaneModel } from '../../api/types.ts';
import type { AgentSetupConfiguration } from '../../composables/useAgentSetup.ts';
import {
  buildModelOptions,
  type ModelOption,
  rankAgentSetupModels,
} from '../../lib/agent-setup-models.ts';
import { Combobox, Select, Switch } from '@floway-dev/ui';

const props = defineProps<{
  agent: 'claude' | 'codex';
  models: readonly ControlPlaneModel[];
  configuration: AgentSetupConfiguration;
}>();

type ClaudeConfiguration = AgentSetupConfiguration['claudeCode'];
type ClaudeEffortLevel = NonNullable<ClaudeConfiguration['effortLevel']>;
type ClaudeCleanupPeriodDays = NonNullable<ClaudeConfiguration['cleanupPeriodDays']>;
type CodexConfiguration = AgentSetupConfiguration['codex'];
export type ConfigurationPatch = {
  claudeCode?: Partial<ClaudeConfiguration>;
  codex?: Partial<CodexConfiguration>;
};
const emit = defineEmits<{ update: [patch: ConfigurationPatch] }>();

const updateClaude = <K extends keyof ClaudeConfiguration>(key: K, value: ClaudeConfiguration[K]) => {
  emit('update', { claudeCode: { [key]: value } });
};
const updateCodex = <K extends keyof CodexConfiguration>(key: K, value: CodexConfiguration[K]) => {
  emit('update', { codex: { [key]: value } });
};

const fieldIds = {
  claudeModel: useId(),
  claudeOpus: useId(),
  claudeSonnet: useId(),
  claudeHaiku: useId(),
  claudeEffort: useId(),
  claudeCleanupPeriod: useId(),
  codexModel: useId(),
  codexEffort: useId(),
};
const fieldGridClass = 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5';

// Reka Select reserves the empty string for clearing. NUL cannot occur in a
// persisted override, so this UI-only value cannot collide with a real model.
const SELECT_NONE = '\u0000none';
const toSelectOptions = (options: ModelOption[]) => options.map(option => ({
  value: option.value ?? SELECT_NONE,
  label: option.modelId === null
    ? 'Default'
    : option.unavailable ? `${option.modelId} (unavailable)` : option.modelId,
}));

const claudeModelOptions = computed(() => toSelectOptions(buildModelOptions(
  props.models,
  props.configuration.claudeCode.model,
  { family: 'claude', picker: 'default' },
)));
const claudeOpusOptions = computed(() => toSelectOptions(buildModelOptions(
  props.models,
  props.configuration.claudeCode.defaultOpusModel,
  { family: 'claude', picker: 'opus' },
)));
const claudeSonnetOptions = computed(() => toSelectOptions(buildModelOptions(
  props.models,
  props.configuration.claudeCode.defaultSonnetModel,
  { family: 'claude', picker: 'sonnet' },
)));
const claudeHaikuOptions = computed(() => toSelectOptions(buildModelOptions(
  props.models,
  props.configuration.claudeCode.defaultHaikuModel,
  { family: 'claude', picker: 'haiku' },
)));
const codexModelOptions = computed(() => toSelectOptions(buildModelOptions(
  props.models,
  props.configuration.codex.model,
  { family: 'codex' },
)));

// Claude Code owns this closed settings enum. Codex effort stays free-form and
// only uses the selected model's advertised values as suggestions.
// Ref: https://docs.claude.com/en/docs/claude-code/settings
const claudeEffortLevels = ['low', 'medium', 'high', 'xhigh'] as const satisfies readonly ClaudeEffortLevel[];
const claudeEffortLabels = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
} satisfies Record<ClaudeEffortLevel, string>;
const isClaudeEffortLevel = (value: string): value is ClaudeEffortLevel =>
  claudeEffortLevels.some(level => level === value);
const claudeEffortOptions: { value: string; label: string }[] = [
  { value: SELECT_NONE, label: 'Default' },
  ...claudeEffortLevels.map(value => ({ value, label: claudeEffortLabels[value] })),
];

// cleanupPeriodDays is a numeric top-level Claude setting. The offered values
// favor long-lived local history, while the sentinel omits the setting.
// Ref: https://code.claude.com/docs/en/settings#available-settings
const claudeCleanupPeriods = [180, 365, 99999] as const satisfies readonly ClaudeCleanupPeriodDays[];
const isClaudeCleanupPeriod = (value: number): value is ClaudeCleanupPeriodDays =>
  claudeCleanupPeriods.some(period => period === value);
const claudeCleanupPeriodOptions = [
  { value: SELECT_NONE, label: 'Default' },
  ...claudeCleanupPeriods.map(value => ({ value: value.toString(), label: `${value} days` })),
];

const codexEffortModel = computed(() => {
  const id = props.configuration.codex.model;
  if (id !== null) return props.models.find(model => model.id === id) ?? null;
  return rankAgentSetupModels(props.models, { family: 'codex' })[0] ?? null;
});
// Codex reasoning-effort presets the combobox suggests, in the upstream-
// advertised order. The value stays opaque: the input retains any non-empty
// string, so suggestions never gate what the operator may submit.
const codexEffortItems = computed(() => {
  const supported = codexEffortModel.value?.chat?.reasoning?.effort?.supported;
  return supported ? [...supported] : [];
});

const claudeModel = computed<string>({
  get: () => props.configuration.claudeCode.model ?? SELECT_NONE,
  set: value => updateClaude('model', value === SELECT_NONE ? null : value),
});
const claudeOpusModel = computed<string>({
  get: () => props.configuration.claudeCode.defaultOpusModel ?? SELECT_NONE,
  set: value => updateClaude('defaultOpusModel', value === SELECT_NONE ? null : value),
});
const claudeSonnetModel = computed<string>({
  get: () => props.configuration.claudeCode.defaultSonnetModel ?? SELECT_NONE,
  set: value => updateClaude('defaultSonnetModel', value === SELECT_NONE ? null : value),
});
const claudeHaikuModel = computed<string>({
  get: () => props.configuration.claudeCode.defaultHaikuModel ?? SELECT_NONE,
  set: value => updateClaude('defaultHaikuModel', value === SELECT_NONE ? null : value),
});
const claudeEffort = computed<string>({
  get: () => props.configuration.claudeCode.effortLevel ?? SELECT_NONE,
  set: value => {
    if (value === SELECT_NONE) updateClaude('effortLevel', null);
    else if (isClaudeEffortLevel(value)) updateClaude('effortLevel', value);
    else throw new Error(`Unexpected Claude effort option: ${value}`);
  },
});
const claudeCleanupPeriod = computed<string>({
  get: () => props.configuration.claudeCode.cleanupPeriodDays?.toString() ?? SELECT_NONE,
  set: value => {
    if (value === SELECT_NONE) {
      updateClaude('cleanupPeriodDays', null);
      return;
    }
    const period = Number(value);
    if (isClaudeCleanupPeriod(period)) updateClaude('cleanupPeriodDays', period);
    else throw new Error(`Unexpected Claude cleanup period option: ${value}`);
  },
});
const modelDiscovery = computed<boolean>({
  get: () => props.configuration.claudeCode.modelDiscovery,
  set: value => updateClaude('modelDiscovery', value),
});
const optOutAiAttribution = computed<boolean>({
  get: () => props.configuration.claudeCode.optOutAiAttribution,
  set: value => updateClaude('optOutAiAttribution', value),
});
const codexModel = computed<string>({
  get: () => props.configuration.codex.model ?? SELECT_NONE,
  set: value => updateCodex('model', value === SELECT_NONE ? null : value),
});
const codexEffort = computed<string>({
  get: () => props.configuration.codex.reasoningEffort ?? '',
  // Only the exact empty input clears the override; every nonempty upstream-owned
  // value — including surrounding whitespace — is preserved verbatim.
  set: value => updateCodex('reasoningEffort', value === '' ? null : value),
});
</script>

<template>
  <section v-if="agent === 'claude'">
    <div data-testid="claude-fields" :class="fieldGridClass">
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
          <Switch v-model="modelDiscovery" size="sm" aria-label="Enable Claude Code gateway model discovery" />
          <span class="text-sm text-white">{{ modelDiscovery ? 'Enabled' : 'Disabled' }}</span>
        </div>
      </div>
      <div data-testid="claude-cleanup-period" class="sm:col-start-1">
        <label :for="fieldIds.claudeCleanupPeriod" class="mb-1.5 block text-xs text-gray-500">Cleanup retention</label>
        <Select :id="fieldIds.claudeCleanupPeriod" v-model="claudeCleanupPeriod" :options="claudeCleanupPeriodOptions" />
      </div>
      <div data-testid="claude-attribution-opt-out">
        <span class="mb-1.5 block text-xs text-gray-500">Opt-out AI attribution</span>
        <div class="flex h-9 items-center gap-2">
          <Switch v-model="optOutAiAttribution" size="sm" aria-label="Opt out of Claude Code AI attribution" />
          <span class="text-sm text-white">{{ optOutAiAttribution ? 'Enabled' : 'Disabled' }}</span>
        </div>
      </div>
    </div>
  </section>

  <section v-else>
    <div data-testid="codex-fields" :class="fieldGridClass">
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
  </section>
</template>
