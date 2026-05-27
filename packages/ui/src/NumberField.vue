<script setup lang="ts">
import { NumberFieldDecrement, NumberFieldIncrement, NumberFieldInput, NumberFieldRoot } from 'reka-ui';
import { computed } from 'vue';

import { cn } from './utils/cn.ts';

const value = defineModel<number | undefined>();

const props = withDefaults(defineProps<{
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  placeholder?: string;
  size?: 'sm' | 'md';
}>(), { size: 'md' });

const containerClass = computed(() => cn(
  'inline-flex w-full items-stretch rounded-[10px] border border-white/[0.06] bg-surface-700',
  'transition-colors hover:border-white/[0.1]',
  'focus-within:border-accent-cyan/50 focus-within:ring-1 focus-within:ring-accent-cyan/30',
  'data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed',
  props.size === 'sm' ? 'h-7' : 'h-9',
));

const inputClass = computed(() => cn(
  'min-w-0 flex-1 bg-transparent text-center text-white placeholder:text-gray-600 focus:outline-none font-mono',
  props.size === 'sm' ? 'text-xs' : 'text-sm',
));

const buttonClass = computed(() => cn(
  'inline-flex aspect-square items-center justify-center text-gray-400 hover:text-white transition-colors disabled:opacity-30 disabled:pointer-events-none',
  props.size === 'sm' ? 'w-7' : 'w-9',
));
</script>

<template>
  <NumberFieldRoot
    v-model="value"
    :min="min"
    :max="max"
    :step="step"
    :disabled="disabled"
    :class="containerClass"
  >
    <NumberFieldDecrement :class="buttonClass">
      <i class="i-lucide-minus size-3.5" />
    </NumberFieldDecrement>
    <NumberFieldInput :class="inputClass" :placeholder="placeholder" />
    <NumberFieldIncrement :class="buttonClass">
      <i class="i-lucide-plus size-3.5" />
    </NumberFieldIncrement>
  </NumberFieldRoot>
</template>
