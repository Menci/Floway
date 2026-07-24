<script setup lang="ts">
import dayjs from 'dayjs';

import type { WireUser } from './types.ts';
import { OverlayScrollbars, Switch } from '@floway-dev/ui';

const props = defineProps<{
  users: WireUser[];
  actorUserId: number;
}>();

defineEmits<{
  edit: [user: WireUser];
  'reset-password': [user: WireUser];
  remove: [user: WireUser];
}>();

// User 1 (seed admin) and the actor themselves cannot be deleted.
const isProtected = (id: number) => id === 1 || id === props.actorUserId;
</script>

<template>
  <OverlayScrollbars>
    <p v-if="users.length === 0" class="text-sm text-gray-500 py-4 text-center">
      No users yet.
    </p>

    <table v-else class="w-full min-w-[760px] text-sm">
      <thead>
        <tr class="border-b border-white/5">
          <th class="text-left py-2 pr-4 pl-2 text-xs font-medium text-gray-500 uppercase tracking-widest">Username</th>
          <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Admin</th>
          <th class="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase tracking-widest">Created</th>
          <th class="text-right py-2 pr-2 text-xs font-medium text-gray-500 uppercase tracking-widest">Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="u in users"
          :key="u.id"
          class="border-b border-white/[0.03]"
        >
          <td class="py-3 pr-4 pl-2">
            <span class="text-white font-medium truncate">{{ u.username }}</span>
          </td>
          <td class="py-3 pr-4">
            <span class="inline-block pointer-events-none" aria-hidden="true">
              <Switch :model-value="u.isAdmin" />
            </span>
          </td>
          <td class="py-3 pr-4">
            <span class="text-gray-500 text-xs cursor-default" :title="dayjs(u.createdAt).format('YYYY-MM-DD HH:mm:ss')">{{ dayjs(u.createdAt).format('MMM D, YYYY') }}</span>
          </td>
          <td class="py-3 pr-2 text-right">
            <div class="flex items-center justify-end gap-1">
              <button
                class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-gray-600 hover:text-accent-cyan hover:bg-white/[0.04] transition-colors p-1"
                title="Edit user"
                aria-label="Edit user"
                @click.stop="$emit('edit', u)"
              >
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  <path d="m15 5 4 4" />
                </svg>
              </button>
              <button
                class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-gray-600 hover:text-accent-cyan hover:bg-white/[0.04] transition-colors p-1"
                title="Reset password"
                aria-label="Reset password"
                @click.stop="$emit('reset-password', u)"
              >
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="8" cy="15" r="4" />
                  <path d="M10.85 12.15 19 4" />
                  <path d="m18 5 2 2" />
                  <path d="m15 8 3 3" />
                </svg>
              </button>
              <button
                class="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-gray-600 hover:text-accent-rose hover:bg-white/[0.04] transition-colors p-1"
                :class="isProtected(u.id) ? 'opacity-30 cursor-not-allowed' : ''"
                :disabled="isProtected(u.id)"
                title="Delete user"
                aria-label="Delete user"
                @click.stop="$emit('remove', u)"
              >
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </OverlayScrollbars>
</template>
