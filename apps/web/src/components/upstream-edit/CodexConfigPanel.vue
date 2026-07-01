<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { CodexAuthorizeUrlResult, CodexImportTab } from './codex-import-types.ts';
import CodexAccountCard from './CodexAccountCard.vue';
import CodexImportTabs from './CodexImportTabs.vue';
import { callApi, useApi } from '../../api/client.ts';
import type { ProxyFallbackEntry, UpstreamRecord } from '../../api/types.ts';
import { clearPkce, deriveChallenge, generatePkce, parseCallbackPaste, peekStashedPkce, pkceStorageKey, recallPkce, stashPkce } from '../../lib/pkce.ts';
import { Button, Spinner } from '@floway-dev/ui';

type CodexUpstreamRecord = Extract<UpstreamRecord, { kind: 'codex' }>;

const props = defineProps<
  | {
    mode: 'create';
    record: null;
    // Current edit-form chain; forwarded into import / re-import (so the OAuth
    // bootstrap routes through the chain the operator is editing AND the
    // chain is persisted on the row) and into refresh-now (so a refresh fired
    // before saving uses the in-progress chain).
    proxyFallbackList: ProxyFallbackEntry[];
  }
  | {
    mode: 'edit';
    record: CodexUpstreamRecord;
    proxyFallbackList: ProxyFallbackEntry[];
  }
>();

const emit = defineEmits<{
  imported: [record: UpstreamRecord];
  error: [message: string];
}>();

const api = useApi();
const storageKey = pkceStorageKey('codex');

const draft = ref<{ activeTab: CodexImportTab; authJsonText: string; callbackUrlText: string }>(
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
// the matching callback comes back as `{code, verifier}` on import.
//
// On re-mount (Vite HMR, router navigation back to this page) the
// component sees a null `pkce` ref but an existing stash. We resume
// from the stash — derive the challenge from the stored verifier and
// rebuild the URL with the same state — so the operator's already-
// opened consent screen stays valid.
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
    () => api.api.upstreams['codex-authorize-url'].$post({ json: { challenge, state } }),
  );
  pkceLoading.value = false;
  if (error) { pkceError.value = error.message; return; }
  pkce.value = data;
};

const importFormVisible = computed(() => props.mode === 'create' || reimportOpen.value);

watch([importFormVisible, () => draft.value.activeTab], ([visible, tab]) => {
  if (visible && tab === 'callback') void prepareAuthorize();
}, { immediate: true });

const buildBody = (): { ok: true; value: { auth_json?: string; callback?: { code: string; verifier: string } } } | { ok: false; error: string } => {
  if (draft.value.activeTab === 'auth_json') {
    const text = draft.value.authJsonText.trim();
    if (!text) return { ok: false, error: 'Paste the contents of ~/.codex/auth.json' };
    try { JSON.parse(text); } catch (e) { return { ok: false, error: `auth.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }; }
    return { ok: true, value: { auth_json: text } };
  }
  const text = draft.value.callbackUrlText.trim();
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
  const body = buildBody();
  if (!body.ok) { emit('error', body.error); return; }

  submitting.value = true;
  // Thread the in-flight proxy chain into both the bootstrap (so OAuth /
  // identity calls route through it) and into persistence (so the new /
  // updated row carries the same chain — same rationale as refresh-now).
  const payload = { ...body.value, proxy_fallback_list: props.proxyFallbackList };
  const result = props.mode === 'create'
    ? await callApi<UpstreamRecord>(
        () => api.api.upstreams['codex-import'].$post({ json: payload }),
      )
    : await callApi<UpstreamRecord>(
        () => api.api.upstreams[':id']['codex-reimport'].$post({ param: { id: props.record.id }, json: payload }),
      );
  submitting.value = false;
  if (result.error) { emit('error', result.error.message); return; }
  // Burn the in-flight stash only on success — the OAuth code is single-use
  // upstream, so a successful exchange invalidates it anyway. On failure the
  // stash survives so the operator can re-paste / retry without losing the
  // verifier+state pair their authorize URL was built against.
  clearPkce(storageKey);
  emit('imported', result.data);
  draft.value = { activeTab: 'auth_json', authJsonText: '', callbackUrlText: '' };
  pkce.value = null;
  reimportOpen.value = false;
};

const refreshTokenNow = async () => {
  if (props.mode !== 'edit') return;
  refreshing.value = true;
  const { data, error } = await callApi<UpstreamRecord>(
    () => api.api.upstreams[':id']['codex-refresh-now'].$post({
      param: { id: props.record.id },
      json: { proxy_fallback_list: props.proxyFallbackList },
    }),
  );
  refreshing.value = false;
  if (error) { emit('error', error.message); return; }
  emit('imported', data);
};
</script>

<template>
  <div class="space-y-4">
    <template v-if="mode === 'edit' && record">
      <CodexAccountCard :record="record" />
      <div class="flex flex-wrap items-center gap-2">
        <Button :loading="refreshing" @click="refreshTokenNow">
          <Spinner v-if="refreshing" class="size-3.5" />
          <i v-else class="i-lucide-refresh-cw size-3.5" />
          Refresh token now
        </Button>
        <Button variant="secondary" @click="reimportOpen = !reimportOpen">
          <i class="i-lucide-key-round size-3.5" />
          {{ reimportOpen ? 'Cancel re-import' : 'Re-import credential' }}
        </Button>
      </div>
    </template>

    <template v-if="importFormVisible">
      <p v-if="mode === 'create'" class="text-xs text-gray-500">
        Codex credentials come from the official Codex CLI. Paste
        <code class="rounded bg-surface-700 px-1 py-0.5 text-[11px] text-gray-300">~/.codex/auth.json</code>
        from a logged-in workstation, or run the OAuth flow yourself and paste the
        URL the browser was redirected to.
      </p>
      <h4 v-else class="text-sm font-semibold text-white">Re-import credential</h4>
      <CodexImportTabs
        v-model:active-tab="draft.activeTab"
        v-model:auth-json-text="draft.authJsonText"
        v-model:callback-url-text="draft.callbackUrlText"
        :pkce="pkce"
        :pkce-loading="pkceLoading"
      />
      <p v-if="pkceError" class="text-xs text-accent-rose">{{ pkceError }}</p>
      <div class="flex justify-end">
        <Button :loading="submitting" @click="submit">
          <Spinner v-if="submitting" class="size-3.5" />
          {{ mode === 'create' ? 'Import' : 'Re-import' }}
        </Button>
      </div>
    </template>
  </div>
</template>
