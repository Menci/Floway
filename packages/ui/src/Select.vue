<script setup lang="ts" generic="T extends string | number">
import { SelectContent, SelectIcon, SelectItem, SelectItemIndicator, SelectItemText, SelectPortal, SelectRoot, SelectTrigger, SelectValue, SelectViewport } from 'reka-ui';
import { computed } from 'vue';

import { cn } from './utils/cn.ts';

interface Option {
  value: T;
  label: string;
  disabled?: boolean;
}

const value = defineModel<T>();

const props = withDefaults(defineProps<{
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}>(), { size: 'md' });

const triggerClass = computed(() => cn(
  'inline-flex w-full items-center justify-between rounded-[10px] border border-white/[0.14] bg-surface-700 text-white',
  'transition-colors hover:border-white/25',
  'focus:outline-none focus:border-accent-cyan/50 focus:ring-1 focus:ring-accent-cyan/30',
  'data-[placeholder]:text-gray-600',
  'disabled:opacity-50 disabled:cursor-not-allowed',
  props.size === 'sm' ? 'h-7 px-2 text-xs' : 'h-9 px-3 text-sm',
));

// Reka's Select stringifies the model value for native elements; cast back to T
// at the boundary so the consumer's defineModel keeps its declared type.
const onUpdate = (raw: string | number | undefined) => {
  value.value = raw as T;
};
</script>

<template>
  <SelectRoot :model-value="value" :disabled="disabled" @update:model-value="onUpdate">
    <SelectTrigger :class="triggerClass">
      <SelectValue :placeholder="placeholder" />
      <SelectIcon class="ml-2 text-gray-300">
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </SelectIcon>
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        position="popper"
        :side-offset="4"
        class="z-50 min-w-[8rem] overflow-hidden rounded-[10px] border border-white/[0.06] bg-surface-800 text-white shadow-xl"
      >
        <SelectViewport class="p-1">
          <SelectItem
            v-for="opt in options"
            :key="String(opt.value)"
            :value="opt.value"
            :disabled="opt.disabled"
            class="relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pl-7 pr-2 text-sm text-white outline-none data-[highlighted]:bg-accent-cyan/10 data-[highlighted]:text-accent-cyan data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed"
          >
            <span class="absolute left-2 flex size-3.5 items-center justify-center">
              <SelectItemIndicator>
                <i class="i-lucide-check size-3.5 text-accent-cyan" />
              </SelectItemIndicator>
            </span>
            <SelectItemText>{{ opt.label }}</SelectItemText>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
