<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { WireUser } from './types.ts';
import { callApi, useApi } from '../../api/client.ts';
import type { UpstreamOption } from '../../composables/useUpstreamOptions.ts';
import SecretInput from '../shared/SecretInput.vue';
import UpstreamPicker, { type UpstreamPickerValue } from '../upstreams/UpstreamPicker.vue';
import { Button, Dialog, Input, Switch } from '@floway-dev/ui';

const open = defineModel<boolean>('open');

const props = defineProps<
  | { mode: 'create'; user?: undefined; actorUserId: number; upstreams: UpstreamOption[] }
  | { mode: 'edit'; user: WireUser; actorUserId: number; upstreams: UpstreamOption[] }
>();

const emit = defineEmits<{
  created: [user: WireUser];
  saved: [userId: number];
}>();

const api = useApi();

const username = ref('');
const password = ref('');
const isAdmin = ref(false);
const canViewGlobalTelemetry = ref(false);
const upstreamSelection = ref<UpstreamPickerValue>({ override: false, ids: [] });
const saving = ref(false);
const error = ref<string | null>(null);

const reset = () => {
  if (props.mode === 'create') {
    username.value = '';
    password.value = '';
    isAdmin.value = false;
    canViewGlobalTelemetry.value = false;
    upstreamSelection.value = { override: false, ids: [] };
  } else {
    username.value = props.user.username;
    password.value = '';
    isAdmin.value = props.user.isAdmin;
    canViewGlobalTelemetry.value = props.user.canViewGlobalTelemetry;
    upstreamSelection.value = props.user.upstreamIds === null
      ? { override: false, ids: [] }
      : { override: true, ids: props.user.upstreamIds };
  }
  error.value = null;
};

watch(open, v => { if (v) reset(); }, { immediate: true });

const isUserOne = computed(() => props.mode === 'edit' && props.user.id === 1);
const isSelf = computed(() => props.mode === 'edit' && props.user.id === props.actorUserId);
const adminLocked = computed(() => isUserOne.value || isSelf.value);
const globalTelemetryLocked = computed(() => isAdmin.value);
const usernameValid = computed(() => /^[a-zA-Z0-9_.\-]{1,64}$/.test(username.value.trim()));

const titleText = computed(() => props.mode === 'create' ? 'New user' : `Edit — ${props.user.username}`);

const submit = async () => {
  if (!usernameValid.value) {
    error.value = 'Username must match [A-Za-z0-9_.-] (1–64 chars)';
    return;
  }
  if (props.mode === 'create' && !password.value) {
    error.value = 'Initial password is required';
    return;
  }
  saving.value = true;
  error.value = null;
  if (upstreamSelection.value.override && upstreamSelection.value.ids.length === 0) {
    error.value = 'Select at least one upstream, or turn off the override to allow all upstreams.';
    return;
  }
  const upstreamIds = upstreamSelection.value.override ? upstreamSelection.value.ids : null;

  if (props.mode === 'create') {
    const { data, error: err } = await callApi<{ user: WireUser }>(
      () => api.api.users.$post({
        json: {
          username: username.value.trim(),
          password: password.value,
          isAdmin: isAdmin.value,
          canViewGlobalTelemetry: canViewGlobalTelemetry.value,
          upstreamIds,
        },
      }),
    );
    saving.value = false;
    if (err) { error.value = err.message; return; }
    open.value = false;
    emit('created', data.user);
    return;
  }

  const target = props.user;
  const body: { username?: string; isAdmin?: boolean; canViewGlobalTelemetry?: boolean; upstreamIds: string[] | null } = { upstreamIds };
  if (username.value.trim() !== target.username) body.username = username.value.trim();
  if (!adminLocked.value && isAdmin.value !== target.isAdmin) body.isAdmin = isAdmin.value;
  if (canViewGlobalTelemetry.value !== target.canViewGlobalTelemetry) body.canViewGlobalTelemetry = canViewGlobalTelemetry.value;
  const { error: err } = await callApi(
    () => api.api.users[':id'].$patch({ param: { id: String(target.id) }, json: body }),
  );
  saving.value = false;
  if (err) { error.value = err.message; return; }
  open.value = false;
  emit('saved', target.id);
};
</script>

<template>
  <Dialog v-model:open="open" :title="titleText" size="lg" :auto-focus-on-open="false">
    <form class="space-y-5" @submit.prevent="submit">
      <div class="space-y-2">
        <label class="block text-xs font-medium text-gray-500">Username</label>
        <Input v-model="username" autocomplete="off" :invalid="username !== '' && !usernameValid" />
        <p class="text-[11px] text-gray-500">Letters, digits, dot, dash, underscore. Max 64 chars.</p>
      </div>

      <div v-if="mode === 'create'" class="space-y-2">
        <label class="block text-xs font-medium text-gray-500">Initial password</label>
        <SecretInput v-model="password" />
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <label class="flex items-center justify-between rounded-md border border-white/[0.06] bg-surface-800/40 px-3 py-2.5">
          <span>
            <p class="text-sm text-white">Administrator</p>
            <p class="text-xs text-gray-500">
              <template v-if="isUserOne">User 1 cannot be demoted.</template>
              <template v-else-if="isSelf">You cannot demote yourself.</template>
              <template v-else>Manages users, upstreams, search config, import/export.</template>
            </p>
          </span>
          <Switch v-model="isAdmin" :disabled="adminLocked" />
        </label>
        <label class="flex items-center justify-between rounded-md border border-white/[0.06] bg-surface-800/40 px-3 py-2.5">
          <span>
            <p class="text-sm text-white">Global telemetry visibility</p>
            <p class="text-xs text-gray-500">
              <template v-if="globalTelemetryLocked">Admins always see global telemetry.</template>
              <template v-else>Allow viewing other users' usage and performance.</template>
            </p>
          </span>
          <Switch
            :model-value="isAdmin || canViewGlobalTelemetry"
            :disabled="globalTelemetryLocked"
            @update:model-value="v => canViewGlobalTelemetry = !!v"
          />
        </label>
      </div>

      <UpstreamPicker
        v-model="upstreamSelection"
        :available="props.upstreams"
        title="Override Available Upstreams"
        inherit-description="When off, this user can use every upstream. Per-key whitelists still apply on top."
      />

      <p v-if="error" class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">{{ error }}</p>

      <footer class="flex items-center justify-end gap-2">
        <Button variant="secondary" type="button" :disabled="saving" @click="open = false">Cancel</Button>
        <Button :loading="saving" type="submit">
          {{ mode === 'create' ? 'Create user' : 'Save changes' }}
        </Button>
      </footer>
    </form>
  </Dialog>
</template>
