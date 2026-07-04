<script setup lang="ts">
import { ref } from 'vue';

import CursorAccountCard from './CursorAccountCard.vue';
import { callApi, useApi } from '../../api/client.ts';
import type { CursorDashboardUsage, ProxyFallbackEntry, UpstreamRecord } from '../../api/types.ts';
import { Button, Card, Spinner, Switch } from '@floway-dev/ui';

type CursorUpstreamRecord = Extract<UpstreamRecord, { kind: 'cursor' }>;

const props = defineProps<
  | {
    mode: 'create';
    record: null;
    // In-flight proxy chain forwarded into authorize-url / poll / refresh-now.
    proxyFallbackList: ProxyFallbackEntry[];
    initialQuota?: CursorDashboardUsage | null;
    initialQuotaError?: string | null;
  }
  | {
    mode: 'edit';
    record: CursorUpstreamRecord;
    proxyFallbackList: ProxyFallbackEntry[];
    initialQuota?: CursorDashboardUsage | null;
    initialQuotaError?: string | null;
  }
>();

const emit = defineEmits<{
  imported: [record: UpstreamRecord];
  error: [message: string];
}>();

// Ghost/privacy mode toggle. Persisted by the page's Save button via a
// config PATCH (see UpstreamEditPage.save). Only meaningful in edit mode.
const privacyMode = defineModel<boolean>('privacyMode', { required: true });

const api = useApi();

interface CursorAuthorizeResult {
  authorize_url: string;
  uuid: string;
  verifier: string;
}

const authorize = ref<CursorAuthorizeResult | null>(null);
const loading = ref(false);
const polling = ref(false);
const refreshing = ref(false);
const reimportOpen = ref(false);

// Fetch the poll parameters, then let the operator open the authorize URL.
// See gateway control-plane/upstreams/routes.ts for the poll protocol.
const prepareAuthorize = async () => {
  if (authorize.value || loading.value) return;
  loading.value = true;
  const { data, error } = await callApi<CursorAuthorizeResult>(
    () => api.api.upstreams['cursor-authorize-url'].$post({ json: { proxy_fallback_list: props.proxyFallbackList } }),
  );
  loading.value = false;
  if (error) { emit('error', error.message); return; }
  authorize.value = data;
};

const poll = async () => {
  if (!authorize.value) return;
  polling.value = true;
  const payload = {
    uuid: authorize.value.uuid,
    verifier: authorize.value.verifier,
    proxy_fallback_list: props.proxyFallbackList,
  };
  const result = props.mode === 'edit' && reimportOpen.value
    ? await callApi<UpstreamRecord>(
        () => api.api.upstreams[':id']['cursor-reimport'].$post({ param: { id: props.record.id }, json: payload }),
      )
    : await callApi<UpstreamRecord>(
        () => api.api.upstreams['cursor-poll'].$post({ json: payload }),
      );
  polling.value = false;
  if (result.error) { emit('error', result.error.message); return; }
  emit('imported', result.data);
  authorize.value = null;
  reimportOpen.value = false;
};

const refreshTokenNow = async () => {
  if (props.mode !== 'edit') return;
  refreshing.value = true;
  const { data, error } = await callApi<UpstreamRecord>(
    () => api.api.upstreams[':id']['cursor-refresh-now'].$post({
      param: { id: props.record.id },
      json: { proxy_fallback_list: props.proxyFallbackList },
    }),
  );
  refreshing.value = false;
  if (error) { emit('error', error.message); return; }
  emit('imported', data);
};

// Max Mode is a settings-only config patch (never touches the account pool),
// persisted immediately so the operator sees the larger-context models on the
// next model-list refresh.
const maxMode = ref(props.mode === 'edit' ? (props.record.config.maxMode ?? false) : false);
const savingMaxMode = ref(false);

const setMaxMode = async (value: boolean) => {
  if (props.mode !== 'edit' || savingMaxMode.value) return;
  savingMaxMode.value = true;
  maxMode.value = value;
  const { data, error } = await callApi<UpstreamRecord>(
    () => api.api.upstreams[':id'].$patch({ param: { id: props.record.id }, json: { config: { maxMode: value } } }),
  );
  savingMaxMode.value = false;
  if (error) { maxMode.value = !value; emit('error', error.message); return; }
  emit('imported', data);
};

// Cursor Tab (StreamCpp) exposed as an OpenAI /v1/completions "cursor-tab"
// model for edit-prediction clients (e.g. Zed). Config-only patch; the model
// appears on the next model-list refresh.
const tabCompletion = ref(props.mode === 'edit' ? (props.record.config.tabCompletion?.enabled ?? false) : false);
const savingTab = ref(false);

const setTabCompletion = async (value: boolean) => {
  if (props.mode !== 'edit' || savingTab.value) return;
  savingTab.value = true;
  tabCompletion.value = value;
  const { data, error } = await callApi<UpstreamRecord>(
    () => api.api.upstreams[':id'].$patch({ param: { id: props.record.id }, json: { config: { tabCompletion: { enabled: value } } } }),
  );
  savingTab.value = false;
  if (error) { tabCompletion.value = !value; emit('error', error.message); return; }
  emit('imported', data);
};
</script>

<template>
  <div class="space-y-4">
    <template v-if="mode === 'edit' && record">
      <!-- Account & credentials: identity + recovery actions (Refresh token /
           Re-import) grouped as one section — credential rotation logically
           belongs with the identity it manages, not sandwiched between
           unrelated setting toggles. The re-import authorize flow expands
           inline so the button and its response stay adjacent. -->
      <Card :padded="false" class="space-y-3 p-4">
        <div>
          <p class="text-sm font-medium text-white">{{ record.config.accounts[0].email }}</p>
          <p class="text-xs text-gray-400">Cursor · {{ record.state?.accounts[0].state ?? 'unknown' }}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Button size="sm" :loading="refreshing" @click="refreshTokenNow">
            <Spinner v-if="refreshing" class="size-3.5" />
            <i v-else class="i-lucide-refresh-cw size-3.5" />
            Refresh token now
          </Button>
          <Button size="sm" variant="secondary" @click="reimportOpen = !reimportOpen">
            <i class="i-lucide-key-round size-3.5" />
            {{ reimportOpen ? 'Cancel re-import' : 'Re-import credential' }}
          </Button>
        </div>
        <template v-if="reimportOpen">
          <div class="border-t border-white/5 pt-3 space-y-3">
            <p class="text-xs text-gray-500">
              Open the authorize URL in a browser and sign in to Cursor, then click Re-import —
              the gateway waits for login to complete and rotates the credential.
            </p>
            <div v-if="!authorize" class="flex justify-end">
              <Button size="sm" :loading="loading" @click="prepareAuthorize">
                <Spinner v-if="loading" class="size-3.5" />
                <i v-else class="i-lucide-link size-3.5" />
                Get authorize URL
              </Button>
            </div>
            <template v-else>
              <div class="rounded-md border border-white/5 bg-surface-800/60 p-3">
                <p class="mb-1 text-xs text-gray-500">Authorize URL</p>
                <code class="break-all text-[11px] text-gray-300">{{ authorize.authorize_url }}</code>
              </div>
              <div class="flex justify-end">
                <Button size="sm" :loading="polling" @click="poll">
                  <Spinner v-if="polling" class="size-3.5" />
                  Re-import
                </Button>
              </div>
            </template>
          </div>
        </template>
      </Card>

      <!-- Subscription usage: read-only observation of the account above. -->
      <CursorAccountCard
        :upstream-id="record.id"
        :account-state="record.state?.accounts[0].state ?? 'unknown'"
        :initial-quota="initialQuota"
        :initial-quota-error="initialQuotaError"
      />

      <!-- Settings: three uniform toggle rows in one card. Each row keeps the
           same label / description / switch structure so the eye reads them
           as members of the same collection rather than three unrelated
           mini-cards with drifting typography. -->
      <Card :padded="false" class="p-4">
        <div class="space-y-4 divide-y divide-white/5">
          <div class="flex items-center justify-between gap-3">
            <div class="pr-3">
              <p class="text-sm font-medium text-white">Privacy mode</p>
              <p class="text-xs text-gray-500">Send the ghost-mode header so Cursor does not use request data for model training. On by default.</p>
            </div>
            <Switch v-model="privacyMode" />
          </div>
          <div class="flex items-center justify-between gap-3 pt-4">
            <div class="pr-3">
              <p class="text-sm font-medium text-white">Max Mode</p>
              <p class="text-xs text-gray-500">
                Send every request in Cursor Max Mode for the largest context window. Consumes more
                usage. Refresh the model list after toggling to see updated context sizes.
              </p>
            </div>
            <Switch :model-value="maxMode" :disabled="savingMaxMode" @update:model-value="v => setMaxMode(!!v)" />
          </div>
          <div class="flex items-center justify-between gap-3 pt-4">
            <div class="pr-3">
              <p class="text-sm font-medium text-white">Tab completion <span class="text-xs text-gray-500">(experimental)</span></p>
              <p class="text-xs text-gray-500">
                Expose Cursor Tab as a <code class="text-gray-400">cursor-tab</code> model on the OpenAI
                <code class="text-gray-400">/v1/completions</code> endpoint for edit-prediction clients (e.g. Zed with the
                Zeta 2.1 prompt format, or any FIM autocomplete client). Refresh the model list after toggling.
                Token usage is <strong class="font-medium text-gray-400">estimated</strong> — Cursor's Tab wire returns no
                per-request usage, so counts are derived from a static byte-per-token ratio (~±10%).
              </p>
            </div>
            <Switch :model-value="tabCompletion" :disabled="savingTab" @update:model-value="v => setTabCompletion(!!v)" />
          </div>
        </div>
      </Card>
    </template>

    <!-- Create mode: first-time login via authorize URL + poll. -->
    <template v-if="mode === 'create'">
      <p class="text-xs text-gray-500">
        Open the authorize URL in a browser and sign in to Cursor, then click
        Poll — the gateway waits for login to complete and persists the upstream.
      </p>

      <div v-if="!authorize" class="flex justify-end">
        <Button :loading="loading" @click="prepareAuthorize">
          <Spinner v-if="loading" class="size-3.5" />
          <i v-else class="i-lucide-link size-3.5" />
          Get authorize URL
        </Button>
      </div>

      <template v-else>
        <div class="rounded-md border border-white/5 bg-surface-800/60 p-3">
          <p class="mb-1 text-xs text-gray-500">Authorize URL</p>
          <code class="break-all text-[11px] text-gray-300">{{ authorize.authorize_url }}</code>
        </div>
        <div class="flex justify-end">
          <Button :loading="polling" @click="poll">
            <Spinner v-if="polling" class="size-3.5" />
            Poll & import
          </Button>
        </div>
      </template>
    </template>
  </div>
</template>
