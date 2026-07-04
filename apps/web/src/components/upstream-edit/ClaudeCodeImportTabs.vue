<script setup lang="ts">
import type { ClaudeCodeAuthorizeUrlResult, ClaudeCodeImportTab } from './claude-code-import-types.ts';
import PkceAuthorizePanel from './PkceAuthorizePanel.vue';
import { Tabs, Textarea } from '@floway-dev/ui';

// `pkce` and `setupTokenPkce` carry independent in-flight PKCE sessions
// because each authorize URL bakes a different `scope` at Anthropic, and
// the operator may open one tab without ever visiting the other. The
// parent fetches each lazily when its tab is selected.
defineProps<{
  pkce: ClaudeCodeAuthorizeUrlResult | null;
  pkceLoading: boolean;
  pkceError: string | null;
  setupTokenPkce: ClaudeCodeAuthorizeUrlResult | null;
  setupTokenPkceLoading: boolean;
  setupTokenPkceError: string | null;
}>();

const activeTab = defineModel<ClaudeCodeImportTab>('activeTab', { required: true });
const credentialsJsonText = defineModel<string>('credentialsJsonText', { required: true });
const callbackUrlText = defineModel<string>('callbackUrlText', { required: true });
const setupTokenCallbackUrlText = defineModel<string>('setupTokenCallbackUrlText', { required: true });

const importTabs = [
  { value: 'callback', label: 'Sign in with Claude' },
  { value: 'setup_token_callback', label: 'Setup Token' },
  { value: 'credentials_json', label: 'Paste credentials.json' },
] as const;
</script>

<template>
  <Tabs v-model="activeTab" :tabs="[...importTabs]">
    <template #callback>
      <PkceAuthorizePanel
        v-model:callback-url-text="callbackUrlText"
        :pkce="pkce"
        :pkce-loading="pkceLoading"
        :pkce-error="pkceError"
        placeholder="https://platform.claude.com/oauth/code/callback?code=...&state=...  (or code#state)"
      >
        <template #info>
          <p class="text-xs text-gray-500">
            Open the authorize URL in a browser signed in to your Claude account, complete the consent screen,
            then paste the URL the browser was redirected to (it starts with
            <code class="rounded bg-surface-700 px-1 py-0.5 text-[11px] text-gray-300">https://platform.claude.com/oauth/code/callback</code>).
            Pasting just the <code class="rounded bg-surface-700 px-1 py-0.5 text-[11px] text-gray-300">?code=&hellip;&amp;state=&hellip;</code> fragment, or the
            <code class="rounded bg-surface-700 px-1 py-0.5 text-[11px] text-gray-300">code#state</code> form shown by the Claude Code CLI, is also accepted.
          </p>
        </template>
      </PkceAuthorizePanel>
    </template>

    <template #setup_token_callback>
      <PkceAuthorizePanel
        v-model:callback-url-text="setupTokenCallbackUrlText"
        :pkce="setupTokenPkce"
        :pkce-loading="setupTokenPkceLoading"
        :pkce-error="setupTokenPkceError"
        placeholder="https://platform.claude.com/oauth/code/callback?code=...&state=...  (or code#state)"
      >
        <template #info>
          <p class="text-xs text-gray-500">
            The Setup Token is a long-lived (~1 year) credential scoped to inference only — it cannot create or
            rotate API keys, and the gateway cannot refresh it. When the token eventually expires you re-import
            a fresh one through this same flow. Preferable to the full OAuth flow for shared deployments where
            the gateway should not hold a credential that can self-mint API keys.
          </p>
        </template>
      </PkceAuthorizePanel>
    </template>

    <template #credentials_json>
      <div class="space-y-3">
        <p class="text-xs text-gray-500">
          Paste the contents of <code class="rounded bg-surface-700 px-1 py-0.5 text-[11px] text-gray-300">~/.claude/.credentials.json</code>
          after signing in with the Claude Code CLI. The gateway keeps only the OAuth refresh token + identity fields.
        </p>
        <div class="flex items-start gap-2 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">
          <i class="i-lucide-triangle-alert mt-0.5 size-4 shrink-0" />
          <span>
            The pasted JSON contains your live OAuth refresh token. Anyone with this file can sign in to your Claude account. Do not share or screenshot.
          </span>
        </div>
        <Textarea
          v-model="credentialsJsonText"
          :rows="10"
          monospace
          placeholder='{"claudeAiOauth": { "accessToken": "...", "refreshToken": "...", "expiresAt": 1750000000000, "subscriptionType": "max_20x" } }'
        />
      </div>
    </template>
  </Tabs>
</template>
