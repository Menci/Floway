<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { computed, ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import PasswordDialog from '../../components/users/PasswordDialog.vue';
import type { WireUser } from '../../components/users/types.ts';
import UserDialog from '../../components/users/UserDialog.vue';
import UsersTable from '../../components/users/UsersTable.vue';
import { useUpstreamOptionsStore } from '../../composables/useUpstreamOptions.ts';
import { type AuthUser, useAuthStore } from '../../stores/auth.ts';
import { Button } from '@floway-dev/ui';

export const useUsersPageData = defineBasicLoader(async () => {
  const api = useApi();
  const upstreamOptions = useUpstreamOptionsStore();
  const [usersRes] = await Promise.all([
    callApi<WireUser[]>(() => api.api.users.$get()),
    upstreamOptions.load(),
  ]);
  const error = usersRes.error?.message ?? upstreamOptions.error.value;
  return { users: usersRes.error ? [] : usersRes.data, error };
});
</script>

<script setup lang="ts">

definePage({ meta: { requiresAdmin: true } });

const api = useApi();
const auth = useAuthStore();
const initial = useUsersPageData();
const upstreamOptionsStore = useUpstreamOptionsStore();

const actorUserId = computed(() => {
  if (!auth.currentUser) throw new Error('users page rendered without an authenticated admin');
  return auth.currentUser.id;
});

const users = ref<WireUser[]>(initial.data.value.users);
const error = ref<string | null>(initial.data.value.error);
const upstreamOptions = computed(() => upstreamOptionsStore.options.value);

const userDialogOpen = ref(false);
const editTarget = ref<WireUser | null>(null);

const passwordOpen = ref(false);
const passwordTarget = ref<WireUser | null>(null);

const reload = async () => {
  const { data, error: err } = await callApi<WireUser[]>(() => api.api.users.$get());
  if (err) { error.value = err.message; return; }
  users.value = data;
  error.value = null;
};

const openCreate = () => {
  editTarget.value = null;
  userDialogOpen.value = true;
};

const editUser = (u: WireUser) => {
  editTarget.value = u;
  userDialogOpen.value = true;
};

const resetPassword = (u: WireUser) => {
  passwordTarget.value = u;
  passwordOpen.value = true;
};

const onUserSaved = async (savedId: number) => {
  await reload();
  // The actor edited their own row; refresh the in-memory user so the admin
  // flag and upstream cap reflect the saved values without having to reload
  // the page (where main.ts would re-hydrate).
  if (savedId === actorUserId.value) {
    const { data, error: err } = await callApi<{ user: AuthUser }>(() => api.auth.me.$get());
    if (err) { error.value = err.message; return; }
    auth.setUser(data.user);
  }
};

const remove = async (u: WireUser) => {
  if (!window.confirm(`Delete user "${u.username}"? Their API keys are soft-deleted and their sessions are revoked.`)) return;
  const { error: err } = await callApi(
    () => api.api.users[':id'].$delete({ param: { id: String(u.id) } }),
  );
  if (err) { window.alert(err.message); return; }
  await reload();
};
</script>

<template>
  <div>
    <div class="glass-card p-5 sm:p-6 animate-in">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
        <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Users</span>
        <Button class="whitespace-nowrap" @click="openCreate">+ New user</Button>
      </div>

      <div v-if="error" class="mb-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
        {{ error }}
      </div>

      <UsersTable
        :users="users"
        :actor-user-id="actorUserId"
        @edit="editUser"
        @reset-password="resetPassword"
        @remove="remove"
      />
    </div>

    <UserDialog
      v-if="userDialogOpen && !editTarget"
      v-model:open="userDialogOpen"
      mode="create"
      :actor-user-id="actorUserId"
      :upstreams="upstreamOptions"
      @created="reload"
    />
    <UserDialog
      v-else-if="editTarget"
      v-model:open="userDialogOpen"
      mode="edit"
      :user="editTarget"
      :actor-user-id="actorUserId"
      :upstreams="upstreamOptions"
      @saved="onUserSaved"
    />
    <PasswordDialog
      v-if="passwordTarget"
      v-model:open="passwordOpen"
      mode="admin"
      :target-user-id="passwordTarget.id"
      :target-username="passwordTarget.username"
      @saved="reload"
    />
  </div>
</template>
