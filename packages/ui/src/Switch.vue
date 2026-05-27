<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from 'reka-ui';

const checked = defineModel<boolean>();

defineProps<{
  disabled?: boolean;
  size?: 'sm' | 'md';
}>();
</script>

<template>
  <SwitchRoot
    v-model="checked"
    :disabled="disabled"
    :class="[
      'relative inline-flex shrink-0 cursor-pointer rounded-full border border-transparent transition-colors',
      'data-[state=checked]:bg-accent-emerald/70 data-[state=unchecked]:bg-surface-600',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/60 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-900',
      'disabled:opacity-50 disabled:cursor-not-allowed',
      size === 'sm' ? 'h-4 w-7' : 'h-5 w-9',
    ]"
  >
    <SwitchThumb
      :class="[
        'pointer-events-none block rounded-full bg-white shadow-sm transition-transform',
        size === 'sm'
          ? 'size-3 data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0.5'
          : 'size-4 data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5',
      ]"
    />
  </SwitchRoot>
</template>
