<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { CodexAuthorizeUrlResult, CodexImportTab } from './codex-import-types.ts';
import CodexAccountCard from './CodexAccountCard.vue';
import CodexImportTabs from './CodexImportTabs.vue';
import { callApi, useApi } from '../../api/client.ts';
import type { UpstreamRecord } from '../../api/types.ts';
import { toRecordEnvelope } from '../../api/types.ts';
import { clearPkce, deriveChallenge, generatePkce, parseCallbackPaste, peekStashedPkce, pkceStorageKey, recallPkce, stashPkce } from '../../lib/pkce.ts';
import { Button } from '@floway-dev/ui';

type CodexUpstreamRecord = Extract<UpstreamRecord, { kind: 'codex' }>;

const props = defineProps<{
  // Every action endpoint takes the draft record as its body. The panel
  // derives its render state from the draft itself — `draft.id === ''`
  // signals create-state, `accounts[0]` signals a credential is present.
  draft: CodexUpstreamRecord;
  saving: boolean;
}>();

const emit = defineEmits<{
  patched: [patch: { config?: unknown; state?: unknown }];
  'save-and-open-edit': [];
  error: [message: string];
}>();

const api = useApi();
const storageKey = pkceStorageKey('codex');

const isCreate = computed(() => props.draft.id === '');
const hasAccount = computed(() => props.draft.config.accounts.length > 0);

const importDraft = ref<{ activeTab: CodexImportTab; authJsonText: string; callbackUrlText: string }>(
  { activeTab: 'auth_json', authJsonText: '', callbackUrlText: '' },
);
const submitting = ref(false);
const refreshing = ref(false);
const reimportOpen = ref(false);

const pkce = ref<CodexAuthorizeUrlResult | null>(null);
const pkceLoading = ref(false);
const pkceError = ref<string | null>(null);

// The verifier + state are minted in-browser, stashed in sessionStorage,
// and the server is asked only to stamp the matching challenge + state
// into its authorize URL. The verifier never leaves the browser until
// the matching callback comes back as `{code, verifier}` on exchange.
//
// On re-mount (Vite HMR, router navigation back to this page) the
// component sees a null `pkce` ref but an existing stash. We resume
// from the stash — derive the challenge from the stored verifier and
// rebuild the URL with the same state — so the already-opened
// consent screen stays valid.
const prepareAuthorize = async () => {
  if (pkce.value || pkceLoading.value) return;
  pkceLoading.value = true;
  pkceError.value = null;
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
  const { data, error } = await callApi<CodexAuthorizeUrlResult>(
    () => api.api.upstreams.codex.oauth['authorize-url'].$post({
      json: { record: toRecordEnvelope(props.draft), challenge, state },
    }),
  );
  pkceLoading.value = false;
  if (error) { pkceError.value = error.message; return; }
  pkce.value = data;
};

const importFormVisible = computed(() => !hasAccount.value || reimportOpen.value);

watch([importFormVisible, () => importDraft.value.activeTab], ([visible, tab]) => {
  if (visible && tab === 'callback') void prepareAuthorize();
}, { immediate: true });

const buildExchangeBody = (): { ok: true; value: { auth_json?: string; callback?: { code: string; verifier: string } } } | { ok: false; error: string } => {
  if (importDraft.value.activeTab === 'auth_json') {
    const text = importDraft.value.authJsonText.trim();
    if (!text) return { ok: false, error: 'Paste the contents of ~/.codex/auth.json' };
    try { JSON.parse(text); } catch (e) { return { ok: false, error: `auth.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }; }
    return { ok: true, value: { auth_json: text } };
  }
  const text = importDraft.value.callbackUrlText.trim();
  if (!text) return { ok: false, error: 'Paste the URL the browser was redirected to' };
  let parsed: { code: string; state: string };
  try { parsed = parseCallbackPaste(text); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  // state validates the round-trip locally (CSRF guard) but is NOT forwarded
  // to the gateway — auth.openai.com 400s on a state parameter.
  const recalled = recallPkce(storageKey, parsed.state);
  if (!recalled) return { ok: false, error: 'Authorization flow not recognized; restart the flow' };
  return { ok: true, value: { callback: { code: parsed.code, verifier: recalled.verifier } } };
};

const submit = async () => {
  const body = buildExchangeBody();
  if (!body.ok) { emit('error', body.error); return; }

  submitting.value = true;
  const { data, error } = await callApi<{ patch: { config?: unknown; state?: unknown } }>(
    () => api.api.upstreams.codex.oauth.exchange.$post({
      json: { record: toRecordEnvelope(props.draft), ...body.value },
    }),
  );
  submitting.value = false;
  if (error) { emit('error', error.message); return; }
  // Burn the in-flight stash only on success — the OAuth code is single-use
  // upstream, so a successful exchange invalidates it anyway. On failure the
  // stash survives so a re-paste / retry works without losing the
  // verifier+state pair the authorize URL was built against.
  clearPkce(storageKey);
  emit('patched', data.patch);
  importDraft.value = { activeTab: 'auth_json', authJsonText: '', callbackUrlText: '' };
  pkce.value = null;
  reimportOpen.value = false;
};

const refreshTokenNow = async () => {
  refreshing.value = true;
  const { data, error } = await callApi<{ patch: { config?: unknown; state?: unknown } }>(
    () => api.api.upstreams.codex.oauth.refresh.$post({ json: { record: toRecordEnvelope(props.draft) } }),
  );
  refreshing.value = false;
  if (error) { emit('error', error.message); return; }
  emit('patched', data.patch);
};
</script>

<template>
  <div class="space-y-4">
    <template v-if="hasAccount">
      <CodexAccountCard :record="draft" />

      <!-- See CopilotInfo for the create-state save-and-load rationale — same
           shape here: no persisted id means list-models can't hit the SWR
           path, so the CTA saves first and lands on the edit page. -->
      <div
        v-if="isCreate"
        class="flex items-center justify-between gap-4 rounded-xl border border-[rgba(0,229,255,0.18)] bg-gradient-to-br from-[rgba(0,229,255,0.08)] to-[rgba(0,229,255,0.02)] px-4 py-3.5"
      >
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-white">Ready to save</p>
          <p class="text-xs text-gray-400">Save this Codex upstream to load its model catalog for review.</p>
        </div>
        <Button :loading="saving" class="shrink-0" @click="emit('save-and-open-edit')">
          <i v-if="!saving" class="i-lucide-save size-3.5" />
          Save and load models
        </Button>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Button v-if="!isCreate" :loading="refreshing" @click="refreshTokenNow">
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
        Codex credentials come from the official Codex CLI. Paste
        <code class="rounded bg-surface-700 px-1 py-0.5 text-[11px] text-gray-300">~/.codex/auth.json</code>
        from a logged-in workstation, or run the OAuth flow yourself and paste the
        URL the browser was redirected to.
      </p>
      <h4 v-else class="text-sm font-semibold text-white">Re-import credential</h4>
      <CodexImportTabs
        v-model:active-tab="importDraft.activeTab"
        v-model:auth-json-text="importDraft.authJsonText"
        v-model:callback-url-text="importDraft.callbackUrlText"
        :pkce="pkce"
        :pkce-loading="pkceLoading"
      />
      <p v-if="pkceError" class="text-xs text-accent-rose">{{ pkceError }}</p>
      <div class="flex justify-end">
        <Button :loading="submitting" @click="submit">
          {{ hasAccount ? 'Re-import' : 'Import' }}
        </Button>
      </div>
    </template>
  </div>
</template>
