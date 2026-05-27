<script setup lang="ts">
// One large bordered radio card used by the upstream provider selector and the
// custom auth-style selector. The accent color is provider-specific in the
// baseline (amber for custom, emerald for azure, cyan for copilot/auth-style),
// so the caller picks the tone via the `tone` prop.

type Tone = 'amber' | 'emerald' | 'cyan';

const props = withDefaults(defineProps<{
  selected: boolean;
  tone?: Tone;
  title: string;
  subtitle?: string;
}>(), { tone: 'cyan' });

defineEmits<{ select: [] }>();

const toneClass: Record<Tone, string> = {
  amber: 'border-accent-amber/40 bg-accent-amber/5',
  emerald: 'border-accent-emerald/40 bg-accent-emerald/5',
  cyan: 'border-accent-cyan/40 bg-accent-cyan/5',
};
</script>

<template>
  <button
    type="button"
    class="w-full text-left rounded-lg border p-3 transition-colors"
    :class="props.selected ? toneClass[props.tone] : 'border-white/[0.14] bg-surface-800/55 hover:border-white/25 hover:bg-surface-800/75'"
    @click="$emit('select')"
  >
    <span class="block text-sm font-semibold text-white">{{ title }}</span>
    <span v-if="subtitle" class="mt-1 block text-xs text-gray-400">{{ subtitle }}</span>
  </button>
</template>
