<script setup lang="ts">
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { computed } from 'vue';

import OverlayScrollbars from './OverlayScrollbars.vue';
import { cn } from './utils/cn.ts';

type Size = 'sm' | 'md' | 'lg' | 'xl' | 'full';

const open = defineModel<boolean>('open');

const props = withDefaults(defineProps<{
  title?: string;
  description?: string;
  size?: Size;
  // Set false when the caller wants to draw its own header / footer flush to
  // the dialog edge (upstream form dialog ships a sticky header + footer bar).
  padded?: boolean;
  // Hide the built-in close affordance for callers that ship their own.
  closeButton?: boolean;
  // Suppress Reka's "focus the first focusable on open" behaviour. The native
  // baseline dashboard didn't auto-focus its dialog inputs, so dialogs that
  // mirror that experience opt out here to avoid the input rendering with a
  // focus ring on every open.
  autoFocusOnOpen?: boolean;
}>(), { size: 'md', padded: true, closeButton: true, autoFocusOnOpen: true });

const sizeClass: Record<Size, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-[min(90vw,72rem)]',
};

// We let DialogContent fill the whole viewport so its inner flex wrapper can
// top-align the card while still vertically centering it for short content.
// This matches the prerender dashboard's modal layout (`flex min-h-full
// items-start ... my-auto`); a pure `top-50% -translate-y-50%` content node
// sits 6px lower than baseline because the centered card no longer participates
// in the same layout as scrollable overflow.
const cardClass = computed(() => cn(
  'relative glass-card glow-cyan my-auto w-full max-h-[calc(100dvh-1.5rem)]',
  props.padded ? 'p-6 overflow-y-auto' : 'overflow-hidden flex flex-col',
  sizeClass[props.size],
));

const onOpenAutoFocus = (event: Event) => {
  if (!props.autoFocusOnOpen) event.preventDefault();
};

const contentA11yAttrs = computed(() => props.description ? {} : { 'aria-describedby': undefined });
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
      <DialogContent class="fixed inset-0 z-50 focus:outline-none" v-bind="contentA11yAttrs" @open-auto-focus="onOpenAutoFocus">
        <OverlayScrollbars class="h-full" content-class="min-h-full">
          <div class="flex min-h-full items-start justify-center p-3 sm:p-5">
          <div :class="cardClass">
            <header v-if="padded && (title || description)" class="mb-4 space-y-1">
              <DialogTitle v-if="title" class="text-lg font-semibold text-white">{{ title }}</DialogTitle>
              <DialogDescription v-if="description" class="text-sm text-gray-400">{{ description }}</DialogDescription>
            </header>
            <template v-else>
              <DialogTitle v-if="title" class="sr-only">{{ title }}</DialogTitle>
              <DialogDescription v-if="description" class="sr-only">{{ description }}</DialogDescription>
            </template>
            <slot />
            <DialogClose v-if="closeButton" class="absolute right-4 top-4 inline-flex size-6 items-center justify-center rounded-[10px] text-gray-500 transition-colors hover:bg-surface-700 hover:text-gray-200">
              <i class="i-lucide-x size-4" />
              <span class="sr-only">Close</span>
            </DialogClose>
          </div>
          </div>
        </OverlayScrollbars>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
