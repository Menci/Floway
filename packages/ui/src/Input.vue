<script setup lang="ts">
import { computed } from 'vue';

import { cn } from './utils/cn.ts';

const props = withDefaults(defineProps<{
  modelValue?: string | number | null;
  type?: 'text' | 'password' | 'email' | 'url' | 'number' | 'search' | 'tel';
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  size?: 'sm' | 'md';
}>(), {
  type: 'text',
  size: 'md',
});

defineEmits<{
  'update:modelValue': [value: string];
}>();

const sizeClass = computed(() => props.size === 'sm' ? 'h-7 px-2 text-xs' : 'h-9 px-3 text-sm');

const classes = computed(() => cn(
  'w-full rounded-[10px] bg-surface-700 border border-white/[0.06] text-white placeholder:text-gray-500',
  'transition-colors',
  'hover:border-white/[0.1]',
  'focus:outline-none focus:border-accent-cyan/50 focus:ring-1 focus:ring-accent-cyan/30',
  'disabled:opacity-50 disabled:cursor-not-allowed',
  props.invalid && 'border-accent-rose/60 focus:border-accent-rose focus:ring-accent-rose/40',
  sizeClass.value,
));
</script>

<template>
  <input
    :type="type"
    :value="modelValue ?? ''"
    :placeholder="placeholder"
    :disabled="disabled"
    :class="classes"
    @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  >
</template>
