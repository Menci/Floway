<script setup lang="ts">
import { computed } from 'vue';

import { resolveUpstreamColor, providerMeta } from './provider-meta.ts';
import type { UpstreamColor, UpstreamProviderKind } from '../../api/types.ts';

// Shared badge / swatch / text chip that reads an upstream's `(kind, color)`
// pair and paints itself with either a static Uno accent class (preset) or an
// inline `color-mix()` style (raw hex). Every upstream label site should go
// through this component so preset + hex renderings stay consistent, and so
// `RequestList` / `UpstreamPicker` stop maintaining their own drifted maps.
const props = withDefaults(defineProps<{
  kind: UpstreamProviderKind;
  color: UpstreamColor | null;
  variant?: 'badge' | 'swatch' | 'text';
  size?: 'sm' | 'md';
  // When true and no `<slot>` content is provided, the kind's label is
  // rendered as the visible text. `<UpstreamBadge :kind :color />` in a
  // header slot uses this; sites that pass their own label (e.g. the
  // upstream's user-facing name) supply a slot and can leave the prop off.
  showLabel?: boolean;
}>(), { variant: 'badge', size: 'md', showLabel: false });

const resolved = computed(() => resolveUpstreamColor({ kind: props.kind, color: props.color }));

const chipClass = computed((): string => {
  const r = resolved.value;
  if (r.mode !== 'class') return '';
  if (props.variant === 'swatch') return r.swatchClass;
  if (props.variant === 'text') return r.textClass;
  return r.badgeClass;
});

const chipStyle = computed((): Record<string, string> => {
  const r = resolved.value;
  if (r.mode !== 'style') return {};
  if (props.variant === 'swatch') return r.swatchStyle;
  if (props.variant === 'text') return r.textStyle;
  return r.badgeStyle;
});

const frameClass = computed((): string => {
  if (props.variant === 'text') return '';
  const size = props.size === 'sm' ? 'h-5 px-1.5 text-[10px]' : 'h-6 px-2 text-xs';
  if (props.variant === 'swatch') {
    return `inline-flex items-center justify-center rounded ${size}`;
  }
  return `inline-flex items-center gap-1 rounded-full border font-medium ${size}`;
});
</script>

<template>
  <span :class="[frameClass, chipClass]" :style="chipStyle">
    <slot>
      <template v-if="showLabel">{{ providerMeta(kind).label }}</template>
    </slot>
  </span>
</template>
