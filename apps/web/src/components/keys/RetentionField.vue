<script setup lang="ts">
import { computed, shallowRef, useId, watch } from 'vue';

import { parseDuration } from '../../utils/parseDuration.ts';
import { Input, Select } from '@floway-dev/ui';

export type RetentionFieldValue = number | null | 'invalid';

interface RetentionPreset {
  readonly seconds: number;
  readonly label: string;
}

const model = defineModel<RetentionFieldValue>({ required: true });
const props = defineProps<{
  label: string;
  description: string;
  offValue: 0 | null;
  offLabel: string;
  presets: readonly RetentionPreset[];
  minimumSeconds?: number;
}>();

type SelectedPreset = 'off' | 'custom' | `seconds:${number}`;

const options: Array<{ value: SelectedPreset; label: string }> = [
  { value: 'off' as const, label: props.offLabel },
  ...props.presets.map(preset => ({ value: `seconds:${preset.seconds}` as SelectedPreset, label: preset.label })),
  { value: 'custom' as const, label: 'Custom…' },
];

const selected = shallowRef<SelectedPreset>('off');
const custom = shallowRef('');
const fieldId = useId();
const labelId = `${fieldId}-label`;
const selectId = `${fieldId}-preset`;
const descriptionId = `${fieldId}-description`;
const customId = `${fieldId}-custom`;
const errorId = `${fieldId}-error`;
let lastEmitted: RetentionFieldValue | undefined;

const durationExamples = computed(() => [
  { value: 30 * 60, label: '30m' },
  { value: 2 * 60 * 60, label: '2h' },
  { value: 3 * 24 * 60 * 60, label: '3d' },
  { value: 30 * 24 * 60 * 60, label: '30d' },
].filter(example => example.value >= (props.minimumSeconds ?? 1)).slice(0, 2));

const formatCustomDuration = (seconds: number): string => {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
};

watch(model, value => {
  if (value === lastEmitted) {
    lastEmitted = undefined;
    return;
  }
  if (value === 'invalid') return;
  if (value === props.offValue) {
    selected.value = 'off';
    custom.value = '';
    return;
  }
  if (value === null) throw new TypeError('RetentionField received null for a zero-off field');
  const preset = props.presets.find(option => option.seconds === value);
  if (preset !== undefined) {
    selected.value = `seconds:${preset.seconds}`;
    custom.value = '';
    return;
  }
  selected.value = 'custom';
  custom.value = formatCustomDuration(value);
}, { immediate: true });

const updateModel = (value: RetentionFieldValue): void => {
  lastEmitted = value;
  model.value = value;
};

const parsedCustomValue = (): number | 'invalid' => {
  const parsed = parseDuration(custom.value);
  return parsed !== null && parsed >= (props.minimumSeconds ?? 1) ? parsed : 'invalid';
};

const updateSelected = (value: SelectedPreset | undefined): void => {
  if (value === undefined) throw new TypeError('RetentionField selection cannot be cleared');
  selected.value = value;
  if (value === 'off') {
    updateModel(props.offValue);
    return;
  }
  if (value === 'custom') {
    updateModel(parsedCustomValue());
    return;
  }
  updateModel(Number(value.slice('seconds:'.length)));
};

const updateCustom = (value: string): void => {
  custom.value = value;
  if (selected.value === 'custom') updateModel(parsedCustomValue());
};

const customInvalid = computed(() => {
  if (selected.value !== 'custom') return false;
  const parsed = parseDuration(custom.value);
  return parsed === null || parsed < (props.minimumSeconds ?? 1);
});
</script>

<template>
  <div class="space-y-2">
    <label :id="labelId" :for="selectId" class="block text-xs font-medium text-gray-500">{{ label }}</label>
    <p :id="descriptionId" class="text-xs text-gray-600">{{ description }}</p>
    <Select
      :id="selectId"
      :model-value="selected"
      :options="options"
      :aria-labelledby="labelId"
      :aria-describedby="descriptionId"
      @update:model-value="updateSelected"
    />
    <Input
      v-if="selected === 'custom'"
      :id="customId"
      :model-value="custom"
      :placeholder="`e.g. ${durationExamples.map(example => example.label).join(', ')}, ${minimumSeconds ?? 1800}`"
      :aria-label="`${label} custom duration`"
      :aria-describedby="customInvalid ? `${descriptionId} ${errorId}` : descriptionId"
      :aria-invalid="customInvalid"
      @update:model-value="updateCustom"
    />
    <p v-if="customInvalid" :id="errorId" class="text-xs text-accent-rose">
      Enter an integer number of seconds or a duration such as {{ durationExamples.map(example => example.label).join(' or ') }}<span v-if="minimumSeconds">, at least {{ formatCustomDuration(minimumSeconds) }}</span>.
    </p>
    <slot />
  </div>
</template>

