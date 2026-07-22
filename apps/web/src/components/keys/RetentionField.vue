<script setup lang="ts">
import { shallowRef, watch } from 'vue';

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
}>();

type SelectedPreset = 'off' | 'custom' | `seconds:${number}`;

const options = [
  { value: 'off', label: props.offLabel },
  ...props.presets.map(preset => ({ value: `seconds:${preset.seconds}`, label: preset.label })),
  { value: 'custom', label: 'Custom…' },
];

const selected = shallowRef<SelectedPreset>('off');
const custom = shallowRef('');

const formatCustomDuration = (seconds: number): string => {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
};

watch(model, value => {
  if (value === 'invalid') return;
  if (value === props.offValue) {
    selected.value = 'off';
    custom.value = '';
    return;
  }
  const preset = props.presets.find(option => option.seconds === value);
  if (preset !== undefined) {
    selected.value = `seconds:${preset.seconds}`;
    custom.value = '';
    return;
  }
  selected.value = 'custom';
  custom.value = formatCustomDuration(value);
}, { immediate: true });

watch(selected, value => {
  if (value === 'off') {
    model.value = props.offValue;
    return;
  }
  if (value === 'custom') {
    model.value = parseDuration(custom.value) ?? 'invalid';
    return;
  }
  model.value = Number(value.slice('seconds:'.length));
});

watch(custom, value => {
  if (selected.value === 'custom') model.value = parseDuration(value) ?? 'invalid';
});
</script>

<template>
  <div class="space-y-2">
    <label class="block text-xs font-medium text-gray-500">{{ label }}</label>
    <p class="text-xs text-gray-600">{{ description }}</p>
    <Select v-model="selected" :options="options" />
    <Input
      v-if="selected === 'custom'"
      v-model="custom"
      placeholder="e.g. 30m, 2h, 3d, 1800"
    />
    <slot />
  </div>
</template>
