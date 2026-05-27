<script setup lang="ts">
import { computed } from 'vue';

import { cn } from './utils/cn.ts';
import Spinner from './Spinner.vue';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

const props = withDefaults(defineProps<{
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
}>(), {
  variant: 'primary',
  size: 'md',
  type: 'button',
});

// Brand-matched variants. Primary keeps the cyan gradient + dark text from the
// prerender dashboard's .btn-primary so headers/CTAs read identical.
const variantClass: Record<Variant, string> = {
  primary: 'bg-gradient-to-br from-[#00b8d4] to-[#00e5ff] text-surface-900 font-semibold hover:brightness-110 hover:shadow-[0_4px_16px_rgba(0,229,255,0.25)]',
  secondary: 'bg-white/[0.04] hover:bg-white/[0.08] text-[#b0bec5] border border-white/[0.08] hover:border-white/[0.15]',
  danger: 'bg-accent-rose/10 hover:bg-accent-rose/20 text-accent-rose border border-accent-rose/30',
  ghost: 'bg-transparent hover:bg-white/[0.04] text-gray-400 hover:text-accent-cyan',
};

const sizeClass: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1',
  md: 'h-9 px-4 text-sm gap-1.5',
  lg: 'h-11 px-6 text-sm tracking-[0.02em] gap-2',
};

const classes = computed(() => cn(
  'inline-flex items-center justify-center rounded-[10px] font-medium transition-all',
  'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none disabled:hover:brightness-100 disabled:hover:shadow-none',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-900 focus-visible:ring-accent-cyan/60',
  variantClass[props.variant],
  sizeClass[props.size],
));
</script>

<template>
  <button :type="type" :class="classes" :disabled="disabled || loading">
    <Spinner v-if="loading" class="size-3.5 shrink-0" />
    <slot />
  </button>
</template>
