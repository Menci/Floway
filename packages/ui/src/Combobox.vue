<script setup lang="ts" generic="T extends AcceptableValue">
import type { AcceptableValue } from 'reka-ui';
import { ComboboxAnchor, ComboboxContent, ComboboxEmpty, ComboboxGroup, ComboboxInput, ComboboxItem, ComboboxItemIndicator, ComboboxPortal, ComboboxRoot, ComboboxTrigger, ComboboxViewport } from 'reka-ui';
import { computed } from 'vue';

import { cn } from './utils/cn.ts';

interface Item {
  value: T;
  label: string;
  detail?: string;
}

const value = defineModel<T | T[]>();

const props = withDefaults(defineProps<{
  items: Item[];
  placeholder?: string;
  emptyText?: string;
  multiple?: boolean;
  disabled?: boolean;
}>(), { emptyText: 'No matches' });

const anchorClass = computed(() => cn(
  'inline-flex w-full items-center rounded-[10px] border border-white/[0.06] bg-surface-700 px-2.5 py-1.5 gap-2',
  'transition-colors hover:border-white/[0.1]',
  'focus-within:border-accent-cyan/50 focus-within:ring-1 focus-within:ring-accent-cyan/30',
));
</script>

<template>
  <ComboboxRoot v-model="value" :multiple="multiple" :disabled="disabled">
    <ComboboxAnchor :class="anchorClass">
      <ComboboxInput
        :placeholder="placeholder"
        class="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-gray-600 focus:outline-none"
      />
      <ComboboxTrigger class="text-gray-400 hover:text-gray-200">
        <i class="i-lucide-chevrons-up-down size-3.5" />
      </ComboboxTrigger>
    </ComboboxAnchor>
    <ComboboxPortal>
      <ComboboxContent
        position="popper"
        :side-offset="4"
        class="z-50 max-h-72 w-[--reka-combobox-trigger-width] overflow-hidden rounded-[10px] border border-white/[0.06] bg-surface-800 shadow-xl"
      >
        <ComboboxViewport class="p-1">
          <ComboboxEmpty class="px-2 py-1.5 text-xs text-gray-500">
            {{ emptyText }}
          </ComboboxEmpty>
          <ComboboxGroup>
            <ComboboxItem
              v-for="item in items"
              :key="String(item.value)"
              :value="item.value"
              class="relative flex cursor-pointer select-none items-center rounded-sm py-1.5 pl-7 pr-2 text-sm text-white outline-none data-[highlighted]:bg-accent-cyan/10 data-[highlighted]:text-accent-cyan data-[disabled]:opacity-50"
            >
              <span class="absolute left-2 flex size-3.5 items-center justify-center">
                <ComboboxItemIndicator>
                  <i class="i-lucide-check size-3.5 text-accent-cyan" />
                </ComboboxItemIndicator>
              </span>
              <span class="truncate">{{ item.label }}</span>
              <span v-if="item.detail" class="ml-auto pl-3 text-xs text-gray-500">{{ item.detail }}</span>
            </ComboboxItem>
          </ComboboxGroup>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>
