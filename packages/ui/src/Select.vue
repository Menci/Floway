<script setup lang="ts" generic="T extends string | number, O extends { value: T; label: string; disabled?: boolean } = { value: T; label: string; disabled?: boolean }">
// Single-select dropdown. Built on reka's ComboboxRoot (not SelectRoot) so it
// shares the ListboxPopover scroll/rounding shell with the other select-family
// controls; the trigger carries no text input, so it reads and behaves as a
// plain select. The hidden ListboxFilter is reka's own workaround for a
// combobox-without-filter regression (unovue/reka-ui#2219).
import { ComboboxAnchor, ComboboxGroup, ComboboxItem, ComboboxItemIndicator, ComboboxRoot, ComboboxTrigger, ListboxFilter } from 'reka-ui';
import { computed, ref } from 'vue';

import ListboxPopover from './internal/ListboxPopover.vue';
import { cn } from './utils/cn.ts';

const value = defineModel<T>();

const props = withDefaults(defineProps<{
  options: O[];
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}>(), { size: 'md' });

// Per-option scoped slot for a second-line description under the label.
// Consumers attach arbitrary metadata to their option objects and the slot
// receives the full option so it can render whatever shape it needs (an
// explanation, a code snippet, badges, ...). Slot absence keeps the
// single-line behavior.
defineSlots<{
  description?: (props: { option: O }) => unknown;
}>();

const open = ref(false);

const selectedLabel = computed(() => props.options.find(opt => opt.value === value.value)?.label);

const triggerClass = computed(() => cn(
  'inline-flex w-full items-center justify-between rounded-[10px] border border-white/[0.14] bg-surface-700 text-white',
  'transition-colors hover:border-white/25',
  'focus:outline-none focus:border-accent-cyan/50 focus:ring-1 focus:ring-accent-cyan/30',
  'data-[state=open]:border-accent-cyan/50',
  'disabled:opacity-50 disabled:cursor-not-allowed',
  props.size === 'sm' ? 'h-7 px-2 text-xs' : 'h-9 px-3 text-sm',
));

const onUpdate = (raw: string | number | undefined) => {
  value.value = raw as T;
};
</script>

<template>
  <ComboboxRoot :model-value="value" v-model:open="open" :disabled="disabled" @update:model-value="onUpdate">
    <!-- Hidden filter: reka regresses a combobox that renders no filter element. -->
    <ListboxFilter class="hidden" />
    <ComboboxAnchor as-child>
      <ComboboxTrigger :id="id" :class="triggerClass">
        <span :class="selectedLabel === undefined && 'text-gray-600'">{{ selectedLabel ?? placeholder }}</span>
        <span class="ml-2 text-gray-300">
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </ComboboxTrigger>
    </ComboboxAnchor>

    <ListboxPopover>
      <ComboboxGroup>
        <ComboboxItem
          v-for="opt in options"
          :key="String(opt.value)"
          :value="opt.value"
          :disabled="opt.disabled"
          class="relative flex w-full cursor-pointer select-none flex-col items-stretch rounded-sm py-1.5 pl-7 pr-2 text-sm text-white outline-none data-[highlighted]:bg-accent-cyan/10 data-[highlighted]:text-accent-cyan data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed"
        >
          <span class="absolute left-2 top-2 flex size-3.5 items-center justify-center">
            <ComboboxItemIndicator>
              <i class="i-lucide-check size-3.5 text-accent-cyan" />
            </ComboboxItemIndicator>
          </span>
          <span>{{ opt.label }}</span>
          <div v-if="$slots.description" class="mt-0.5">
            <slot name="description" :option="opt" />
          </div>
        </ComboboxItem>
      </ComboboxGroup>
    </ListboxPopover>
  </ComboboxRoot>
</template>
