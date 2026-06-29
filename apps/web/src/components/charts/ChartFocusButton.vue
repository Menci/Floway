<script setup lang="ts">
defineEmits<{ toggle: [] }>();
</script>

<template>
  <button
    type="button"
    class="absolute bottom-2 right-2 inline-flex min-h-7 min-w-7 items-center justify-center rounded-md p-1 transition-colors text-gray-500 hover:text-gray-300 hover:bg-white/[0.04]"
    title="Invert selections"
    @click="$emit('toggle')"
  >
    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
    </svg>
  </button>
</template>
