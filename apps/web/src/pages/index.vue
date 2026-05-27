<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';

import { useAuthStore } from '../stores/auth.ts';

// definePage is a compile-time macro from unplugin-vue-router. It only fires
// inside <script setup>, and only when called without an import — the runtime
// shim from `unplugin-vue-router/runtime` is a no-op intended for type-only
// scenarios. Types come from `unplugin-vue-router/client` in vite-env.d.ts.
definePage({ meta: { public: true } });

const router = useRouter();
const auth = useAuthStore();

// `/` hands off to the right home for the current identity. The auth guard
// covers /dashboard children but not `/` itself, since this page is public.
onMounted(() => {
  void router.replace(auth.isAuthenticated ? '/dashboard' : '/login');
});
</script>

<template>
  <div class="grid min-h-screen place-items-center bg-zinc-950 text-sm text-zinc-500">Loading…</div>
</template>
