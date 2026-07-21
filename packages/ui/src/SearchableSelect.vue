<script setup lang="ts">
// Strict, searchable single-select. Built on reka's ComboboxRoot with a text
// ComboboxInput that filters the list, but only ever commits a value that
// exists in `options` — the operator cannot type a free-form value. A `null`
// model is the "Default" row, rendered in the UI font while option rows render
// monospace, so an option literally labelled "Default" stays distinguishable.
// A model value that no option carries also reads as Default.
import { ComboboxAnchor, ComboboxEmpty, ComboboxGroup, ComboboxInput, ComboboxItem, ComboboxItemIndicator, ComboboxRoot, ComboboxTrigger, useFilter } from 'reka-ui';
import { computed, ref, watch } from 'vue';

import ListboxPopover from './internal/ListboxPopover.vue';
import { cn } from './utils/cn.ts';

interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

const value = defineModel<string | null>({ required: true });

const props = withDefaults(defineProps<{
  options: Option[];
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  defaultLabel?: string;
}>(), { size: 'md', defaultLabel: 'Default' });

// reka matches an item to the model by value equality and types that value as a
// string here. A NUL-prefixed string is the Default row's value: it can never
// collide with a real option and stays entirely inside this component — the
// public model still speaks `string | null`.
const DEFAULT_VALUE = '\u0000default';

const { contains } = useFilter({ sensitivity: 'base' });

const query = ref('');
const open = ref(false);

const optionByValue = computed(() => new Map(props.options.map(option => [option.value, option])));
const isKnown = (v: string | null): v is string => v !== null && optionByValue.value.has(v);

const selectedLabel = computed(() => isKnown(value.value) ? optionByValue.value.get(value.value)!.label : props.defaultLabel);
const rootValue = computed(() => isKnown(value.value) ? value.value : DEFAULT_VALUE);
const displayValue = (raw: string) => raw === DEFAULT_VALUE ? props.defaultLabel : (optionByValue.value.get(raw)?.label ?? props.defaultLabel);

const filteredOptions = computed(() => query.value === ''
  ? props.options
  : props.options.filter(option => contains(option.label, query.value) || contains(option.value, query.value)));
const defaultVisible = computed(() => query.value === '' || contains(props.defaultLabel, query.value));

// Fresh filter on open; restore the committed label on close. reka resets the
// input text on blur/select on its own, but a programmatic close needs this.
watch(open, isOpen => { query.value = isOpen ? '' : selectedLabel.value; });

const onSelect = (raw: string) => {
  value.value = raw === DEFAULT_VALUE ? null : raw;
  open.value = false;
};

const inputClass = computed(() => cn(
  'w-full rounded-[10px] border border-white/[0.14] bg-surface-700 pr-9 text-white',
  'transition-colors hover:border-white/25',
  'focus:outline-none focus:border-accent-cyan/50 focus:ring-1 focus:ring-accent-cyan/30',
  'placeholder:text-gray-600 disabled:opacity-50 disabled:cursor-not-allowed',
  props.size === 'sm' ? 'h-7 pl-2 text-xs' : 'h-9 pl-3 text-sm',
));

const itemClass = 'relative flex cursor-pointer select-none items-center rounded-sm py-1.5 pl-7 pr-2 text-sm outline-none data-[highlighted]:bg-accent-cyan/10 data-[highlighted]:text-accent-cyan data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed';
</script>

<template>
  <ComboboxRoot
    :model-value="rootValue"
    v-model:open="open"
    :disabled="disabled"
    @update:model-value="onSelect"
  >
    <ComboboxAnchor as-child>
      <div class="relative w-full">
        <ComboboxInput
          :id="id"
          v-model="query"
          :display-value="displayValue"
          :placeholder="placeholder"
          :disabled="disabled"
          :class="inputClass"
        />
        <ComboboxTrigger class="absolute inset-y-0 right-0 grid w-9 place-items-center text-gray-400 hover:text-gray-200" tabindex="-1">
          <i class="i-lucide-chevrons-up-down size-3.5" />
        </ComboboxTrigger>
      </div>
    </ComboboxAnchor>

    <ListboxPopover>
      <ComboboxEmpty v-if="filteredOptions.length === 0 && !defaultVisible" class="px-2 py-1.5 text-xs text-gray-500">
        No matches
      </ComboboxEmpty>
      <ComboboxGroup>
        <!-- Default row: UI font, so a model literally named "Default" stays distinct. -->
        <ComboboxItem v-if="defaultVisible" :value="DEFAULT_VALUE" :class="[itemClass, 'text-white']">
          <span class="absolute left-2 flex size-3.5 items-center justify-center">
            <ComboboxItemIndicator>
              <i class="i-lucide-check size-3.5 text-accent-cyan" />
            </ComboboxItemIndicator>
          </span>
          <span>{{ defaultLabel }}</span>
        </ComboboxItem>
        <ComboboxItem
          v-for="option in filteredOptions"
          :key="option.value"
          :value="option.value"
          :disabled="option.disabled"
          :class="[itemClass, 'text-white']"
        >
          <span class="absolute left-2 flex size-3.5 items-center justify-center">
            <ComboboxItemIndicator>
              <i class="i-lucide-check size-3.5 text-accent-cyan" />
            </ComboboxItemIndicator>
          </span>
          <span class="truncate font-mono">{{ option.label }}</span>
        </ComboboxItem>
      </ComboboxGroup>
    </ListboxPopover>
  </ComboboxRoot>
</template>
