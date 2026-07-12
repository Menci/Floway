<script setup lang="ts">
import { computed } from 'vue';

import { cn } from './utils/cn.ts';

type Tone = 'neutral' | 'cyan' | 'emerald' | 'amber' | 'rose' | 'violet' | 'zinc';

const props = withDefaults(defineProps<{
  tone?: Tone;
  size?: 'sm' | 'md';
}>(), { tone: 'neutral', size: 'md' });

const toneClass: Record<Tone, string> = {
  neutral: 'bg-surface-700 text-gray-300 border-white/[0.1]',
  cyan: 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30',
  emerald: 'bg-accent-emerald/10 text-accent-emerald border-accent-emerald/30',
  amber: 'bg-accent-amber/10 text-accent-amber border-accent-amber/30',
  rose: 'bg-accent-rose/10 text-accent-rose border-accent-rose/30',
  violet: 'bg-accent-violet/10 text-accent-violet border-accent-violet/30',
  zinc: 'bg-surface-600 text-gray-200 border-white/[0.1]',
};

const classes = computed(() => cn(
  'inline-flex items-center gap-1 rounded-full border font-medium',
  toneClass[props.tone],
  props.size === 'sm' ? 'h-5 px-1.5 text-[10px]' : 'h-6 px-2 text-xs',
));
</script>

<template>
  <span :class="classes">
    <slot />
  </span>
</template>
