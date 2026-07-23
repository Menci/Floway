<script setup lang="ts">
import { computed, shallowRef, useId, watch } from 'vue';

import { parseDuration } from '../../utils/parseDuration.ts';
import { Input, Select } from '@floway-dev/ui';

export type RetentionFieldValue = number | null | 'invalid';

interface RetentionPreset {
  readonly seconds: number;
  readonly label: string;
}

type CustomInputUnit = 'duration' | 'days';

const SECONDS_PER_DAY = 24 * 60 * 60;

const model = defineModel<RetentionFieldValue>({ required: true });
const props = withDefaults(defineProps<{
  label: string;
  description: string;
  offValue: 0 | null;
  offLabel: string;
  presets: readonly RetentionPreset[];
  minimumSeconds?: number;
  maximumSeconds?: number;
  customInputUnit?: CustomInputUnit;
}>(), {
  customInputUnit: 'duration',
});

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
].filter(example => (
  example.value >= (props.minimumSeconds ?? 1)
  && example.value <= (props.maximumSeconds ?? Number.MAX_SAFE_INTEGER)
)).slice(0, 2));

const formatDuration = (seconds: number): string => {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
};

const formatCustomValue = (seconds: number): string => {
  if (props.customInputUnit === 'duration') return formatDuration(seconds);
  if (seconds % SECONDS_PER_DAY !== 0) throw new TypeError('Day-based retention must contain a whole number of days');
  return String(seconds / SECONDS_PER_DAY);
};

const parseCustomValue = (input: string): number | null => {
  const seconds = props.customInputUnit === 'duration'
    ? parseDuration(input)
    : /^\d+$/.test(input.trim())
      ? Number(input.trim()) * SECONDS_PER_DAY
      : null;
  if (
    seconds === null
    || !Number.isSafeInteger(seconds)
    || seconds < (props.minimumSeconds ?? 1)
    || seconds > (props.maximumSeconds ?? Number.MAX_SAFE_INTEGER)
  ) return null;
  return seconds;
};

const customPlaceholder = computed(() => props.customInputUnit === 'days'
  ? 'e.g. 14'
  : `e.g. ${durationExamples.value.map(example => example.label).join(', ')}, ${props.minimumSeconds ?? 1800}`);

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
  custom.value = formatCustomValue(value);
}, { immediate: true });

const updateModel = (value: RetentionFieldValue): void => {
  lastEmitted = value;
  model.value = value;
};

const parsedCustomValue = (): number | 'invalid' => {
  return parseCustomValue(custom.value) ?? 'invalid';
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
  return parseCustomValue(custom.value) === null;
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
    <div v-if="selected === 'custom'" class="relative">
      <Input
        :id="customId"
        :model-value="custom"
        :type="customInputUnit === 'days' ? 'number' : 'text'"
        :placeholder="customPlaceholder"
        :class="customInputUnit === 'days' ? 'pr-16' : undefined"
        :aria-label="`${label} custom duration`"
        :aria-describedby="customInvalid ? `${descriptionId} ${errorId}` : descriptionId"
        :aria-invalid="customInvalid"
        @update:model-value="updateCustom"
      />
      <span v-if="customInputUnit === 'days'" class="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-gray-500">days</span>
    </div>
    <p v-if="customInvalid" :id="errorId" class="text-xs text-accent-rose">
      <template v-if="customInputUnit === 'days'">
        Enter a whole number of days<span v-if="minimumSeconds">, at least {{ minimumSeconds / SECONDS_PER_DAY }}</span>.
      </template>
      <template v-else>
        Enter an integer number of seconds or a duration such as {{ durationExamples.map(example => example.label).join(' or ') }}<span v-if="minimumSeconds">, at least {{ formatDuration(minimumSeconds) }}</span>.
      </template>
    </p>
    <slot />
  </div>
</template>
