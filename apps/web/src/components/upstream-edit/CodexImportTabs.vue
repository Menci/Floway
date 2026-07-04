<script setup lang="ts">
// PKCE state arrives via props and the three text/tab pieces are v-model so
// this component stays a presentation-only paste area.

import type { CodexAuthorizeUrlResult, CodexImportTab } from './codex-import-types.ts';
import PkceAuthorizePanel from './PkceAuthorizePanel.vue';
import { Tabs, Textarea } from '@floway-dev/ui';

defineProps<{
  pkce: CodexAuthorizeUrlResult | null;
  pkceLoading: boolean;
}>();

const activeTab = defineModel<CodexImportTab>('activeTab', { required: true });
const authJsonText = defineModel<string>('authJsonText', { required: true });
const callbackUrlText = defineModel<string>('callbackUrlText', { required: true });

const importTabs = [
  { value: 'auth_json', label: 'Paste auth.json' },
  { value: 'callback', label: 'Paste login URL' },
] as const;
</script>

<template>
  <Tabs v-model="activeTab" :tabs="[...importTabs]">
    <template #auth_json>
      <div class="space-y-3">
        <p class="text-xs text-gray-500">
          Paste the contents of <code class="rounded bg-surface-700 px-1 py-0.5 text-[11px] text-gray-300">~/.codex/auth.json</code>
          after signing in with the Codex CLI. The gateway keeps only the OAuth refresh token + identity fields.
        </p>
        <Textarea
          v-model="authJsonText"
          :rows="10"
          monospace
          placeholder='{"OPENAI_API_KEY": null, "tokens": { ... }, "last_refresh": "..." }'
        />
      </div>
    </template>

    <template #callback>
      <PkceAuthorizePanel
        v-model:callback-url-text="callbackUrlText"
        :pkce="pkce"
        :pkce-loading="pkceLoading"
        :pkce-error="null"
        placeholder="http://localhost:1455/auth/callback?code=...&state=..."
      >
        <template #info>
          <p class="text-xs text-gray-500">
            Open the authorize URL in a browser signed in to ChatGPT, complete the consent screen,
            then paste the URL the browser was redirected to (it starts with
            <code class="rounded bg-surface-700 px-1 py-0.5 text-[11px] text-gray-300">http://localhost:1455/auth/callback</code>).
            Pasting just the <code class="rounded bg-surface-700 px-1 py-0.5 text-[11px] text-gray-300">?code=&hellip;&amp;state=&hellip;</code> fragment is also accepted.
          </p>
        </template>
      </PkceAuthorizePanel>
    </template>
  </Tabs>
</template>
