<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

import { callApi, useApi } from '../api/client.ts';
import { useLoading } from '../composables/useLoading.ts';
import { type AuthUser, useAuthStore } from '../stores/auth.ts';
import { Input } from '@floway-dev/ui';

definePage({ meta: { public: true } });

const api = useApi();
const router = useRouter();
const auth = useAuthStore();

const usernameInput = ref('');
const passwordInput = ref('');
const errorMessage = ref<string | null>(null);

const [loading, submit] = useLoading(async () => {
  errorMessage.value = null;
  const username = usernameInput.value.trim();
  if (username && !passwordInput.value) {
    errorMessage.value = 'Enter a password to continue.';
    return;
  }

  const { data, error } = await callApi<{ token: string; user: AuthUser }>(
    () => api.auth.login.$post({ json: { username, password: passwordInput.value } }),
  );
  if (error) {
    errorMessage.value = error.message;
    return;
  }
  if (!data) return;

  auth.setAuth({ token: data.token, user: data.user });
  await router.replace('/dashboard/settings');
});
</script>

<template>
  <main class="flex min-h-screen items-center justify-center p-4">
    <div class="pointer-events-none fixed left-1/2 top-0 h-[400px] w-[600px] -translate-x-1/2 rounded-full bg-accent-cyan/5 blur-[120px]" />

    <div class="w-full max-w-md">
      <div class="mb-8 text-center">
        <div class="glow-border mb-6 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-700">
          <svg class="h-8 w-8 text-accent-cyan" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </div>
        <h1 class="text-2xl font-semibold tracking-tight text-white">Floway</h1>
        <p class="mt-2 text-sm font-light text-gray-500">Sign in with your account</p>
      </div>

      <div class="glass-card glow-cyan p-8">
        <p class="mb-6 text-xs leading-relaxed text-gray-500">
          Leave the username blank to sign in as the default admin user. In local development without an
          <span class="text-gray-400">ADMIN_KEY</span>, leave the password blank too; otherwise enter the deployment's
          <span class="text-gray-400">ADMIN_KEY</span>.
        </p>

        <form class="space-y-5" @submit.prevent="submit">
          <div>
            <label for="username" class="mb-2 block text-xs font-medium uppercase tracking-widest text-gray-400">Username</label>
            <Input
              id="username"
              v-model="usernameInput"
              type="text"
              placeholder="(leave blank for default admin)"
              autocomplete="username"
              autofocus
            />
          </div>

          <div>
            <label for="password" class="mb-2 block text-xs font-medium uppercase tracking-widest text-gray-400">Password</label>
            <Input
              id="password"
              v-model="passwordInput"
              type="password"
              placeholder="Enter your password..."
              :invalid="!!errorMessage"
              autocomplete="current-password"
            />
          </div>

          <button type="submit" class="btn-primary w-full" :disabled="loading">
            <span v-if="!loading">Sign in</span>
            <span v-else class="inline-flex items-center justify-center gap-2">
              <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" opacity="0.25" />
                <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75" />
              </svg>
              Signing in...
            </span>
          </button>
        </form>

        <div v-if="errorMessage" class="mt-4 rounded-lg border border-accent-rose/20 bg-accent-rose/10 p-3 text-sm text-accent-rose">
          {{ errorMessage }}
        </div>
      </div>
    </div>
  </main>
</template>
