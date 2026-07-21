<script setup lang="ts">
// Shared dropdown popover body for every select-family control (Select,
// Combobox, TagCombobox, SearchableSelect). All of them build on reka's
// ComboboxRoot, so the popover shell is uniform: a popper-positioned surface
// sized to the trigger, with the item list scrolled by our OverlayScrollbars
// overlay (reka's own viewport hides its native scrollbar). This mirrors the
// reka-listbox + overlayscrollbars pattern proven in Marina's MySelect.vue.
//
// Callers supply the rows (items, empty state, create row) through the default
// slot; the rounded/width/scroll contract lives only here.
import { ComboboxContent, ComboboxPortal, ComboboxViewport } from 'reka-ui';
import type { HTMLAttributes } from 'vue';

import OverlayScrollbars from '../OverlayScrollbars.vue';
import { cn } from '../utils/cn.ts';

const props = defineProps<{
  class?: HTMLAttributes['class'];
}>();
</script>

<template>
  <ComboboxPortal>
    <ComboboxContent
      position="popper"
      :side-offset="4"
      :class="cn(
        'z-50 flex flex-col overflow-hidden rounded-[10px] border border-white/[0.06] bg-surface-800 p-1 text-white shadow-xl',
        props.class,
      )"
      :style="{ width: 'var(--reka-popper-anchor-width)' }"
    >
      <ComboboxViewport>
        <OverlayScrollbars class="max-h-[calc(0.5*var(--svh))]" no-tabindex :v-scrollbar-offset="{ x: 2 }">
          <slot />
        </OverlayScrollbars>
      </ComboboxViewport>
    </ComboboxContent>
  </ComboboxPortal>
</template>
