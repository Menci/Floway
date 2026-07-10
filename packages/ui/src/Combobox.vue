<script setup lang="ts">
// Single-select combobox with free-form input. The operator can type a value
// the suggestion list does not contain and the typed string becomes the
// model value verbatim — useful for fields the gateway forwards verbatim and
// does not enum-gate.
//
// Visual contract matches Select.vue / TagCombobox.vue (dark popover,
// surface-700 trigger). HTML5 `<input list>` + `<datalist>` would have
// been one line but the browser-rendered popover is white-on-dark-only
// on every major browser, which is jarring inside the dashboard's dark
// theme.
import {
  ComboboxAnchor, ComboboxContent, ComboboxEmpty, ComboboxGroup, ComboboxInput,
  ComboboxItem, ComboboxItemIndicator, ComboboxPortal, ComboboxRoot, ComboboxTrigger,
  ComboboxViewport, useFilter,
} from 'reka-ui';
import { computed, nextTick, ref, watch } from 'vue';

interface Item {
  value: string;
  label?: string;
}

// Post-normalize shape: `label` is always set (defaults to `value`), so the
// template can read `item.label` directly instead of falling back per row.
interface NormalizedItem {
  value: string;
  label: string;
}

const value = defineModel<string>({ required: true });

const props = withDefaults(defineProps<{
  /** Suggestion list. Each item's `value` is what gets committed; `label` is the visible row text. */
  items: readonly (string | Item)[];
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  inputmode?: 'text' | 'numeric' | 'decimal';
  /** Tailwind classes applied to the trigger input (e.g. `font-mono`). */
  inputClass?: string;
  /** Override the default "no matches" copy shown when the typed value already matches nothing. */
  emptyText?: string;
  /**
   * Drop the bordered surface-700 shell so the input blends into its parent
   * row. Used when the combobox is embedded in an already-bordered container
   * (e.g. a Card row title) where a second border would double up.
   */
  borderless?: boolean;
  /**
   * Hide the right-edge chevron that toggles the dropdown. The popover still
   * opens on focus / click because the input itself owns `open-on-focus`;
   * removing the chevron keeps the title visually clean when the parent row
   * already carries its own action cluster on the right.
   */
  hideDropdownTrigger?: boolean;
}>(), {
  emptyText: 'No matches',
});

const { contains } = useFilter({ sensitivity: 'base' });

// Normalize the items list to a single shape so the template only deals
// with `{ value, label }`. Strings collapse to `{ value: s, label: s }`.
const normalizedItems = computed<NormalizedItem[]>(() => props.items.map(it =>
  typeof it === 'string' ? { value: it, label: it } : { value: it.value, label: it.label ?? it.value }));

// query mirrors value so the input always shows the committed string. Reka's
// ComboboxInput owns the typed text via its own v-model; we keep them in
// sync so an outside change to the model (form reset, prefill) updates the
// visible text too.
const query = ref(value.value);
watch(value, v => { if (v !== query.value) query.value = v; });

// Single writer: every keystroke pushes the raw query into `value` so the
// save gate of any consuming dialog reflects what the operator typed
// without waiting for blur. Trimming is the caller's job — doing it here
// would clip a trailing space mid-keystroke and force the operator to
// re-press space to keep typing. ComboboxRoot's own onChange path still
// fires for clicked rows and just re-writes the same value via this
// watch.
watch(query, q => { value.value = q; });

// Always show every suggestion; rank items whose label or value contains the
// typed query above the rest, preserving the original order within each
// group. Empty query keeps the configured order untouched. The operator
// always sees the full set of presets — typing narrows attention to the
// top of the list without hiding the alternatives.
const orderedItems = computed<NormalizedItem[]>(() => {
  if (query.value === '') return normalizedItems.value;
  const matches: NormalizedItem[] = [];
  const rest: NormalizedItem[] = [];
  for (const item of normalizedItems.value) {
    if (contains(item.label, query.value) || contains(item.value, query.value)) {
      matches.push(item);
    } else {
      rest.push(item);
    }
  }
  return [...matches, ...rest];
});

const trimmedQuery = computed(() => query.value.trim());
const hasExactMatch = computed(() => normalizedItems.value.some(item => item.value === trimmedQuery.value));
const showCreateOption = computed(() => trimmedQuery.value !== '' && !hasExactMatch.value);

const open = ref(false);

// Reka's Combobox only registers items present in the DOM. When the operator
// types a brand-new value, surface a synthesized "Use 'foo'" row so the
// arrow keys + Enter path still commits it. The `watch(query)` above is
// the sole writer to `value`; this handler just closes the popover after
// the operator confirms.
const commitTyped = async () => {
  open.value = false;
  await nextTick();
};
</script>

<template>
  <ComboboxRoot
    v-model="value"
    v-model:open="open"
    :disabled="disabled"
    :display-value="(v: string) => v"
    open-on-focus
  >
    <ComboboxAnchor as-child>
      <div class="relative w-full">
        <ComboboxInput
          :id="id"
          v-model="query"
          :placeholder="placeholder"
          :disabled="disabled"
          :inputmode="inputmode"
          :class="[
            borderless
              ? 'h-9 w-full bg-transparent text-sm text-white border-0 focus:outline-none focus:ring-0 placeholder:text-gray-600'
              : [
                'h-9 w-full rounded-[10px] border border-white/[0.14] bg-surface-700 pl-3 text-sm text-white',
                'transition-colors hover:border-white/25',
                'focus:outline-none focus:border-accent-cyan/50 focus:ring-1 focus:ring-accent-cyan/30',
                'placeholder:text-gray-600',
              ],
            !borderless && (hideDropdownTrigger ? 'pr-3' : 'pr-9'),
            borderless && 'px-0',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            inputClass,
          ]"
        />
        <ComboboxTrigger
          v-if="!hideDropdownTrigger"
          class="absolute inset-y-0 right-0 grid w-9 place-items-center text-gray-400 hover:text-gray-200"
          tabindex="-1"
        >
          <i class="i-lucide-chevrons-up-down size-3.5" />
        </ComboboxTrigger>
      </div>
    </ComboboxAnchor>

    <ComboboxPortal>
      <ComboboxContent
        position="popper"
        :side-offset="4"
        class="z-50 max-h-72 w-[--reka-combobox-trigger-width] overflow-hidden rounded-[10px] border border-white/[0.06] bg-surface-800 text-white shadow-xl"
      >
        <ComboboxViewport class="p-1">
          <ComboboxEmpty v-if="orderedItems.length === 0 && !showCreateOption" class="px-2 py-1.5 text-xs text-gray-500">
            {{ emptyText }}
          </ComboboxEmpty>
          <ComboboxGroup>
            <ComboboxItem
              v-if="showCreateOption"
              :value="trimmedQuery"
              class="relative flex cursor-pointer select-none items-center rounded-sm py-1.5 pl-7 pr-2 text-sm text-accent-cyan outline-none data-[highlighted]:bg-accent-cyan/10"
              @select="commitTyped"
            >
              <span class="absolute left-2 flex size-3.5 items-center justify-center">
                <i class="i-lucide-plus size-3.5" />
              </span>
              <span class="truncate">Use "<span class="font-mono">{{ trimmedQuery }}</span>"</span>
            </ComboboxItem>
            <ComboboxItem
              v-for="item in orderedItems"
              :key="item.value"
              :value="item.value"
              class="relative flex cursor-pointer select-none items-center rounded-sm py-1.5 pl-7 pr-2 text-sm text-white outline-none data-[highlighted]:bg-accent-cyan/10 data-[highlighted]:text-accent-cyan"
            >
              <span class="absolute left-2 flex size-3.5 items-center justify-center">
                <ComboboxItemIndicator>
                  <i class="i-lucide-check size-3.5 text-accent-cyan" />
                </ComboboxItemIndicator>
              </span>
              <span class="truncate">{{ item.label }}</span>
              <span v-if="item.label !== item.value" class="ml-auto pl-3 font-mono text-xs text-gray-500">{{ item.value }}</span>
            </ComboboxItem>
          </ComboboxGroup>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>
