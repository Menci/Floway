<script setup lang="ts">
import { computed } from 'vue';

import { resolveUpstreamColor } from './upstream-paint.ts';
import type { UpstreamColor, UpstreamProviderKind } from '../../api/types.ts';

// Shared badge / swatch / text / fill / chip surface that reads an
// upstream's `(kind, color)` pair and paints itself with either a static
// Uno accent class (preset) or an inline `color-mix()` style (raw hex).
// Single source of truth for the kind→color paint so preset and hex
// renderings stay consistent.
//
// Variants:
//   - `badge`: pill with border + padded label — the header/list chip.
//   - `swatch`: centered filled box, subtly tinted — icon backdrop; the
//     caller picks its own size + shape via utility classes
//     (`size-8 rounded-full`, `size-10 rounded-md`, ...).
//   - `text`: bare coloured text run — the request-log row label.
//   - `fill`: `bg-current` surface for quantitative surfaces (progress
//     bars, meters) where the caller supplies width / height via
//     class or style. The wrapping element handles frame + sizing;
//     this only paints.
//   - `chip`: saturated fill for the picker's preset swatches — reads
//     as the tone itself rather than as a background tinted by the tone.
const props = withDefaults(defineProps<{
  kind: UpstreamProviderKind;
  color: UpstreamColor | null;
  variant?: 'badge' | 'swatch' | 'text' | 'fill' | 'chip';
  size?: 'sm' | 'md';
}>(), { variant: 'badge', size: 'md' });

// One dispatch — indexes the resolver's slot-keyed records so class and
// style never fall out of sync when a new variant is added. `fill` reuses
// `text`'s slot: both paths write `color:`, and the consumer relies on
// `bg-current` to pick that up.
const paint = computed((): { class: string; style: Record<string, string> } => {
  const r = resolveUpstreamColor({ kind: props.kind, color: props.color });
  const slot = props.variant === 'fill' ? 'text' : props.variant;
  return r.mode === 'class'
    ? { class: r.classes[slot], style: {} }
    : { class: '', style: r.styles[slot] };
});

const frameClass = computed((): string => {
  if (props.variant === 'text') return '';
  if (props.variant === 'swatch' || props.variant === 'chip') return 'inline-flex items-center justify-center';
  if (props.variant === 'fill') return 'bg-current';
  const size = props.size === 'sm' ? 'h-5 px-1.5 text-[10px]' : 'h-6 px-2 text-xs';
  return `inline-flex items-center gap-1 rounded-full border font-medium ${size}`;
});
</script>

<template>
  <span :class="[frameClass, paint.class]" :style="paint.style">
    <slot />
  </span>
</template>
