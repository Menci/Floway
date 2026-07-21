<script setup lang="ts">
// Multi-select that renders selected values as deletable chips, autocompletes
// from a provided item list, AND accepts arbitrary free-form values: typing an
// id that matches no item and pressing Enter adds it as a tag. Built by nesting
// reka-ui's TagsInput inside its Combobox so both share one string[] model.
//
// Enter coordination (no double-add) is reka-ui's own: ListboxRoot.onKeydownEnter
// only preventDefault()s when a suggestion is highlighted, and TagsInputInput's
// handler awaits a tick then bails if the event was already prevented. So a
// highlighted suggestion is selected via the Combobox path, while unmatched free
// text falls through to TagsInput's add path. Crucially we do NOT put
// `@keydown.enter.prevent` on the input — that would pre-mark the event prevented
// and permanently disable free-form add.
// Ref: reka-ui 2.9.8 TagsInput/TagsInputInput.vue + Listbox/ListboxRoot.vue.
import {
  ComboboxAnchor, ComboboxEmpty, ComboboxGroup, ComboboxInput,
  ComboboxItem, ComboboxItemIndicator, ComboboxRoot, ComboboxTrigger,
  TagsInputInput, TagsInputItem, TagsInputItemDelete, TagsInputRoot,
  useFilter,
} from 'reka-ui';
import { computed, ref, watch } from 'vue';

import ListboxPopover from './internal/ListboxPopover.vue';

interface Item {
  value: string;
  label: string;
  detail?: string;
}

const value = defineModel<string[]>({ required: true });

const props = withDefaults(defineProps<{
  items: Item[];
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  highlight?: readonly string[];
}>(), { emptyText: 'Type an id and press Enter to add' });

const { contains } = useFilter({ sensitivity: 'base' });

const query = ref('');

// labelFor falls back to the raw id so orphan entries — ids no longer in the
// item list — still render and stay removable.
const itemByValue = computed(() => new Map(props.items.map(item => [item.value, item])));
const labelFor = (id: string): string => itemByValue.value.get(id)?.label ?? id;

const highlightSet = computed(() => new Set(props.highlight ?? []));
const isHighlighted = (id: string): boolean => highlightSet.value.has(id);

const filteredItems = computed(() => props.items.filter(item =>
  !value.value.includes(item.value)
  && (contains(item.label, query.value) || contains(item.value, query.value))));

watch(value, () => { query.value = ''; }, { deep: true });
</script>

<template>
  <ComboboxRoot v-model="value" :disabled="disabled" multiple>
    <ComboboxAnchor as-child>
      <TagsInputRoot
        v-model="value"
        :disabled="disabled"
        delimiter=""
        class="flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-[10px] border border-white/[0.14] bg-surface-700 px-2 py-1.5 transition-colors focus-within:border-accent-cyan/50 focus-within:ring-1 focus-within:ring-accent-cyan/30 hover:border-white/25 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50"
      >
        <TagsInputItem
          v-for="id in value"
          :key="id"
          :value="id"
          :class="[
            'flex items-center gap-1 rounded-md border py-0.5 pl-2 pr-1 text-xs',
            isHighlighted(id)
              ? 'border-accent-cyan bg-surface-900 text-accent-cyan shadow-[0_0_8px_rgba(0,229,255,0.45)] data-[state=active]:border-accent-cyan'
              : 'border-white/10 bg-surface-600 text-gray-100 data-[state=active]:border-accent-cyan/50',
          ]"
        >
          <span class="font-mono">{{ labelFor(id) }}</span>
          <TagsInputItemDelete class="grid size-4 place-items-center rounded text-gray-400 hover:bg-white/10 hover:text-accent-rose">
            <i class="i-lucide-x size-3" />
          </TagsInputItemDelete>
        </TagsInputItem>

        <ComboboxInput v-model="query" as-child>
          <TagsInputInput
            :placeholder="value.length === 0 ? placeholder : ''"
            class="min-w-[8rem] flex-1 bg-transparent px-1 text-sm text-white placeholder:text-gray-600 focus:outline-none"
          />
        </ComboboxInput>

        <ComboboxTrigger class="ml-auto text-gray-400 hover:text-gray-200" tabindex="-1">
          <i class="i-lucide-chevrons-up-down size-3.5" />
        </ComboboxTrigger>
      </TagsInputRoot>
    </ComboboxAnchor>

    <ListboxPopover>
      <ComboboxEmpty class="px-2 py-1.5 text-xs text-gray-500">
        {{ emptyText }}
      </ComboboxEmpty>
      <ComboboxGroup>
        <ComboboxItem
          v-for="item in filteredItems"
          :key="item.value"
          :value="item.value"
          :class="[
            'relative flex cursor-pointer select-none items-center rounded-sm py-1.5 pl-7 pr-2 text-sm outline-none data-[highlighted]:bg-accent-cyan/10 data-[highlighted]:text-accent-cyan',
            isHighlighted(item.value) ? 'text-accent-cyan' : 'text-white',
          ]"
        >
          <span class="absolute left-2 flex size-3.5 items-center justify-center">
            <ComboboxItemIndicator>
              <i class="i-lucide-check size-3.5 text-accent-cyan" />
            </ComboboxItemIndicator>
          </span>
          <span class="truncate">{{ item.label }}</span>
          <span v-if="item.detail" class="ml-auto pl-3 font-mono text-xs text-gray-500">{{ item.detail }}</span>
        </ComboboxItem>
      </ComboboxGroup>
    </ListboxPopover>
  </ComboboxRoot>
</template>
