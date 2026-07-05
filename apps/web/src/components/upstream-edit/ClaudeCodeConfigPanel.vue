<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { ClaudeCodeAuthorizeUrlResult, ClaudeCodeImportTab } from './claude-code-import-types.ts';
import ClaudeCodeAccountCard from './ClaudeCodeAccountCard.vue';
import ClaudeCodeImportTabs from './ClaudeCodeImportTabs.vue';
import { callApi, useApi } from '../../api/client.ts';
import type { ClaudeCodeUpstreamState, UpstreamRecord } from '../../api/types.ts';
import { toRecordEnvelope } from '../../api/types.ts';
import { clearPkce, deriveChallenge, generatePkce, parseCallbackPaste, peekStashedPkce, pkceStorageKey, recallPkce, stashPkce } from '../../lib/pkce.ts';
import { Button } from '@floway-dev/ui';

type ClaudeCodeUpstreamRecord = Extract<UpstreamRecord, { kind: 'claude-code' }>;

const props = defineProps<{
  draft: ClaudeCodeUpstreamRecord;
  saving: boolean;
}>();

const emit = defineEmits<{
  patched: [patch: { config?: unknown; state?: unknown }];
  'save-and-open-edit': [];
  error: [message: string];
}>();

const api = useApi();

const isCreate = computed(() => props.draft.id === '');
const hasAccount = computed(() => props.draft.config.accounts.length > 0);

const importDraft = ref<{
  activeTab: ClaudeCodeImportTab;
  credentialsJsonText: string;
  callbackUrlText: string;
  setupTokenCallbackUrlText: string;
}>({ activeTab: 'callback', credentialsJsonText: '', callbackUrlText: '', setupTokenCallbackUrlText: '' });
const submitting = ref(false);
const refreshing = ref(false);
const probing = ref(false);
const reimportOpen = ref(false);

const pkce = ref<ClaudeCodeAuthorizeUrlResult | null>(null);
const pkceLoading = ref(false);
const pkceError = ref<string | null>(null);

const setupTokenPkce = ref<ClaudeCodeAuthorizeUrlResult | null>(null);
const setupTokenPkceLoading = ref(false);
const setupTokenPkceError = ref<string | null>(null);

// The verifier + state are minted in-browser, stashed in sessionStorage,
// and the server is asked only to stamp the matching challenge + state
// into its authorize URL. The verifier never leaves the browser until
// the matching callback comes back as `{code, verifier, state}` on
// exchange. Each kind (oauth / setup-token) owns its own storage slot so
// preparing one flow never invalidates the other.
const prepareAuthorize = async (kind: 'oauth' | 'setup-token') => {
  const target = kind === 'oauth' ? pkce : setupTokenPkce;
  const loadingFlag = kind === 'oauth' ? pkceLoading : setupTokenPkceLoading;
  const errorFlag = kind === 'oauth' ? pkceError : setupTokenPkceError;
  if (target.value || loadingFlag.value) return;
  loadingFlag.value = true;
  errorFlag.value = null;
  const storageKey = pkceStorageKey('claude-code', kind);
  const stash = peekStashedPkce(storageKey);
  let verifier: string;
  let challenge: string;
  let state: string;
  if (stash) {
    ({ verifier, state } = stash);
    challenge = await deriveChallenge(verifier);
  } else {
    ({ verifier, challenge, state } = await generatePkce());
    stashPkce(storageKey, { verifier, state });
  }
  const endpoint = kind === 'oauth'
    ? api.api.upstreams['claude-code'].oauth['authorize-url']
    : api.api.upstreams['claude-code']['setup-token']['authorize-url'];
  const { data, error } = await callApi<ClaudeCodeAuthorizeUrlResult>(
    () => endpoint.$post({ json: { record: toRecordEnvelope(props.draft), challenge, state } }),
  );
  loadingFlag.value = false;
  if (error) { errorFlag.value = error.message; return; }
  target.value = data;
};

const importFormVisible = computed(() => !hasAccount.value || reimportOpen.value);

watch([importFormVisible, () => importDraft.value.activeTab], ([visible, tab]) => {
  if (!visible) return;
  if (tab === 'callback') void prepareAuthorize('oauth');
  else if (tab === 'setup_token_callback') void prepareAuthorize('setup-token');
}, { immediate: true });

type CallbackCredential = { code: string; verifier: string; state: string };

type SubmitPayload =
  | { kind: 'oauth-credentials_json'; credentials_json: string }
  | { kind: 'oauth-callback'; callback: CallbackCredential }
  | { kind: 'setup-token-callback'; callback: CallbackCredential };

const buildCallbackCredential = (pasteText: string, kind: 'oauth' | 'setup-token'): { ok: true; value: CallbackCredential } | { ok: false; error: string } => {
  const text = pasteText.trim();
  if (!text) return { ok: false, error: 'Paste the URL the browser was redirected to' };
  let parsed: { code: string; state: string };
  try { parsed = parseCallbackPaste(text); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  const recalled = recallPkce(pkceStorageKey('claude-code', kind), parsed.state);
  if (!recalled) return { ok: false, error: 'Authorization flow not recognized; restart the flow' };
  return { ok: true, value: { code: parsed.code, verifier: recalled.verifier, state: parsed.state } };
};

const buildBody = (): { ok: true; value: SubmitPayload } | { ok: false; error: string } => {
  if (importDraft.value.activeTab === 'credentials_json') {
    const text = importDraft.value.credentialsJsonText.trim();
    if (!text) return { ok: false, error: 'Paste the contents of ~/.claude/.credentials.json' };
    try { JSON.parse(text); } catch (e) { return { ok: false, error: `credentials.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }; }
    return { ok: true, value: { kind: 'oauth-credentials_json', credentials_json: text } };
  }
  if (importDraft.value.activeTab === 'setup_token_callback') {
    const credential = buildCallbackCredential(importDraft.value.setupTokenCallbackUrlText, 'setup-token');
    if (!credential.ok) return credential;
    return { ok: true, value: { kind: 'setup-token-callback', callback: credential.value } };
  }
  const credential = buildCallbackCredential(importDraft.value.callbackUrlText, 'oauth');
  if (!credential.ok) return credential;
  return { ok: true, value: { kind: 'oauth-callback', callback: credential.value } };
};

const submit = async () => {
  if (submitting.value) return;
  const body = buildBody();
  if (!body.ok) { emit('error', body.error); return; }

  submitting.value = true;
  const record = toRecordEnvelope(props.draft);
  const { data, error } = await callApi<{ patch: { config?: unknown; state?: unknown } }>(() => {
    const payload = body.value;
    if (payload.kind === 'setup-token-callback') {
      return api.api.upstreams['claude-code']['setup-token'].exchange.$post({
        json: { record, callback: payload.callback },
      });
    }
    if (payload.kind === 'oauth-credentials_json') {
      return api.api.upstreams['claude-code'].oauth.exchange.$post({
        json: { record, credentials_json: payload.credentials_json },
      });
    }
    return api.api.upstreams['claude-code'].oauth.exchange.$post({
      json: { record, callback: payload.callback },
    });
  });
  submitting.value = false;
  if (error) { emit('error', error.message); return; }
  // Single-use OAuth code: clear only on success and only the kind we just
  // exchanged, so a failed attempt can re-paste against the same verifier
  // and a parallel kind's stash stays intact.
  if (body.value.kind === 'oauth-callback') clearPkce(pkceStorageKey('claude-code', 'oauth'));
  else if (body.value.kind === 'setup-token-callback') clearPkce(pkceStorageKey('claude-code', 'setup-token'));
  emit('patched', data.patch);
  importDraft.value = { activeTab: 'callback', credentialsJsonText: '', callbackUrlText: '', setupTokenCallbackUrlText: '' };
  pkce.value = null;
  setupTokenPkce.value = null;
  reimportOpen.value = false;
};

// Refresh-now is only meaningful for OAuth credentials (setup-token has
// no rotation counterpart). The button is hidden for setup-token rows AND
// for empty-account rows so a doomed affordance never renders.
const refreshable = computed(() => {
  const account = props.draft.state?.accounts[0];
  return account?.tokenKind === 'oauth';
});

const refreshTokenNow = async () => {
  if (refreshing.value) return;
  refreshing.value = true;
  const { data, error } = await callApi<{ patch: { state?: unknown } }>(
    () => api.api.upstreams['claude-code'].oauth.refresh.$post({ json: { record: toRecordEnvelope(props.draft) } }),
  );
  refreshing.value = false;
  if (error) { emit('error', error.message); return; }
  emit('patched', data.patch);
};

const refreshQuotaNow = async () => {
  if (probing.value) return;
  if (!props.draft.state || props.draft.state.accounts.length === 0) {
    emit('error', 'Quota probe requires a Claude Code credential — re-import to populate state.');
    return;
  }
  probing.value = true;
  const { data, error } = await callApi<{
    fetched_at: string;
    body: unknown;
    patch: { state?: ClaudeCodeUpstreamState };
  }>(
    () => api.api.upstreams['claude-code'].probe.$post({ json: { record: toRecordEnvelope(props.draft) } }),
  );
  probing.value = false;
  if (error) { emit('error', error.message); return; }
  if (data.patch.state) emit('patched', { state: data.patch.state });
};
</script>

<template>
  <div class="space-y-4">
    <template v-if="hasAccount">
      <ClaudeCodeAccountCard :record="draft" :probing="probing" @refresh-quota="refreshQuotaNow" />

      <!-- See CopilotInfo for the create-state save-and-load rationale — same
           shape here: no persisted id means list-models can't hit the SWR
           path, so the CTA saves first and lands on the edit page. -->
      <div
        v-if="isCreate"
        class="flex items-center justify-between gap-4 rounded-xl border border-[rgba(0,229,255,0.18)] bg-gradient-to-br from-[rgba(0,229,255,0.08)] to-[rgba(0,229,255,0.02)] px-4 py-3.5"
      >
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-white">Ready to save</p>
          <p class="text-xs text-gray-400">Save this Claude Code upstream to load its model catalog for review.</p>
        </div>
        <Button :loading="saving" class="shrink-0" @click="emit('save-and-open-edit')">
          <i v-if="!saving" class="i-lucide-save size-3.5" />
          Save and load models
        </Button>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Button v-if="!isCreate && refreshable" :loading="refreshing" @click="refreshTokenNow">
          <i v-if="!refreshing" class="i-lucide-refresh-cw size-3.5" />
          Refresh token now
        </Button>
        <Button variant="secondary" @click="reimportOpen = !reimportOpen">
          <i class="i-lucide-key-round size-3.5" />
          {{ reimportOpen ? 'Cancel re-import' : 'Re-import credential' }}
        </Button>
      </div>
    </template>

    <template v-if="importFormVisible">
      <p v-if="!hasAccount" class="text-xs text-gray-500">
        Claude Code credentials come from the official Claude desktop / CLI. Sign in through the OAuth browser
        flow below, paste a long-lived Setup Token (inference-only, safer for shared deployments), or paste
        <code class="rounded bg-surface-700 px-1 py-0.5 text-[11px] text-gray-300">~/.claude/.credentials.json</code>
        from a logged-in workstation.
      </p>
      <h4 v-else class="text-sm font-semibold text-white">Re-import credential</h4>
      <ClaudeCodeImportTabs
        v-model:active-tab="importDraft.activeTab"
        v-model:credentials-json-text="importDraft.credentialsJsonText"
        v-model:callback-url-text="importDraft.callbackUrlText"
        v-model:setup-token-callback-url-text="importDraft.setupTokenCallbackUrlText"
        :pkce="pkce"
        :pkce-loading="pkceLoading"
        :pkce-error="pkceError"
        :setup-token-pkce="setupTokenPkce"
        :setup-token-pkce-loading="setupTokenPkceLoading"
        :setup-token-pkce-error="setupTokenPkceError"
      />
      <div class="flex justify-end">
        <Button :loading="submitting" @click="submit">
          {{ hasAccount ? 'Re-import' : 'Import' }}
        </Button>
      </div>
    </template>
  </div>
</template>
