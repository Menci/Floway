<script setup lang="ts">
// Native checkbox styled with the brand accent, matching the canonical
// pattern that the prerender dashboard and the upstream-form dialog use
// (no Reka primitive needed — the native control is accessible and styles
// cleanly with `accent-*`). Wrap in a <label> with siblings on the consumer
// side for click-target + descriptive copy.

const checked = defineModel<boolean>();

defineProps<{
  disabled?: boolean;
}>();
</script>

<template>
  <input
    type="checkbox"
    class="accent-accent-cyan h-4 w-4 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
    :checked="checked"
    :disabled="disabled"
    @change="checked = ($event.target as HTMLInputElement).checked"
  >
</template>
