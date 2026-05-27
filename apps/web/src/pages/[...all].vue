<script setup lang="ts">
import { Button } from '@floway-dev/ui';
import { RouterLink } from 'vue-router';

definePage({ meta: { public: true } });
</script>

<template>
  <main class="grid min-h-screen place-items-center bg-surface-900 p-6 text-white">
    <div class="space-y-4 text-center">
      <p class="text-7xl font-semibold text-gray-700">404</p>
      <p class="text-base text-gray-400">This page doesn't exist.</p>
      <RouterLink to="/">
        <Button variant="secondary">Go home</Button>
      </RouterLink>
    </div>
  </main>
</template>
