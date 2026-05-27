<script setup lang="ts">
// Simple disclosure used inside the upstream dialog for Path Overrides and
// Feature Flags. The header is rendered as a button so it stays keyboard-
// reachable; an optional count chip appears in cyan when count > 0.

defineProps<{
  label: string;
  count?: number;
}>();

const open = defineModel<boolean>('open', { default: false });
</script>

<template>
  <div>
    <button
      type="button"
      class="mb-2 flex w-full items-center justify-between text-left text-xs font-medium text-gray-500 transition-colors hover:text-gray-300"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="flex items-center gap-1.5">
        <span>{{ label }}</span>
        <span v-if="count && count > 0" class="font-mono text-[10px] text-accent-cyan">(+{{ count }})</span>
      </span>
      <span class="flex items-center gap-2 normal-case tracking-normal text-[10px] text-gray-600">
        <svg class="h-3 w-3 transition-transform" :class="open && 'rotate-180'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </span>
    </button>
    <div v-show="open">
      <slot />
    </div>
  </div>
</template>
