<script setup lang="ts">
// URL parsing runs on every keystroke via parseProxyUri. Import from the
// package's /url, /proxy-config, and /constants subpaths rather than the
// barrel — the barrel pulls in runProxiedRequest and the userspace TLS
// stack, which transitively depend on Node's crypto and inflate the
// dashboard bundle. The parser itself is pure (no SocketDial, no TLS),
// so the subpath gives live feedback without dial-time code.

import { useNow } from '@vueuse/core';
import { computed, nextTick, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';

import { defaultsFor } from './proxy-form-defaults.ts';
import ProxyConfigForm from './ProxyConfigForm.vue';
import { callApi, useApi } from '../../api/client.ts';
import type { BackoffRow, ProxyConflictBody, ProxyRecord } from '../../api/types.ts';
import { useProxiesStore } from '../../composables/useProxies.ts';
import { useUpstreamsStore } from '../../composables/useUpstreams.ts';
import { formatCountdown } from '../../utils/format-countdown.ts';
import { DEFAULT_DIAL_DEADLINE_MS } from '@floway-dev/proxy/constants';
import type { ProxyConfig } from '@floway-dev/proxy/proxy-config';
import { formatProxyUri, parseProxyUri } from '@floway-dev/proxy/url';
import { Button, Dialog, Input } from '@floway-dev/ui';

const open = defineModel<boolean>('open', { required: true });

const props = defineProps<{
  /** null = create; non-null = edit. */
  record: ProxyRecord | null;
}>();

const emit = defineEmits<{
  saved: [];
}>();

const api = useApi();
const proxiesStore = useProxiesStore();
const upstreamsStore = useUpstreamsStore();

const mode = computed<'create' | 'edit'>(() => (props.record ? 'edit' : 'create'));

const name = ref(props.record?.name ?? '');
const url = ref(props.record?.url ?? '');
const lastEgressIp = ref<string | null>(null);

const tryParse = (raw: string): { ok: true; config: ProxyConfig } | { ok: false; error: string } | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return { ok: true, config: parseProxyUri(trimmed) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

// Canonical form-side state. In edit mode, seeded by parsing the row's URL;
// in create mode, seeded with an empty HTTP default so the form panel
// renders before the operator types a URL. When the URL becomes
// unparseable mid-edit we keep the last good config so the form does not
// reset under the operator, and dim it via the urlError prop instead.
const initialParse = tryParse(url.value);
const initialConfig: ProxyConfig | null = initialParse?.ok
  ? initialParse.config
  : (mode.value === 'create' ? defaultsFor('http', { host: '', port: 0, name: '' }) : null);
const config = ref<ProxyConfig | null>(initialConfig);
const urlError = ref<string | null>(initialParse && !initialParse.ok ? initialParse.error : null);

// Single-tick guard: whichever side just pushed a change tags itself as
// the source so the other side's watcher can skip re-deriving and avoid a
// feedback loop. Cleared on the next tick.
let lastSource: 'url' | 'form' | null = null;

watch(url, next => {
  if (lastSource === 'form') { lastSource = null; return; }
  const parsed = tryParse(next);
  if (parsed === null) {
    lastSource = 'url';
    config.value = null;
    urlError.value = null;
    void nextTick(() => { if (lastSource === 'url') lastSource = null; });
    return;
  }
  if (parsed.ok) {
    lastSource = 'url';
    config.value = parsed.config;
    urlError.value = null;
    void nextTick(() => { if (lastSource === 'url') lastSource = null; });
  } else {
    urlError.value = parsed.error;
  }
});

watch(config, next => {
  if (lastSource === 'url') { lastSource = null; return; }
  lastSource = 'form';
  url.value = formatProxyUri(next!);
  urlError.value = null;
  void nextTick(() => { if (lastSource === 'form') lastSource = null; });
});

// Per-proxy dial-stage deadline. Stored as a string to make "empty" the
// canonical "use default" signal; coerced to a number on save.
const DEFAULT_DIAL_TIMEOUT_SECONDS = Math.floor(DEFAULT_DIAL_DEADLINE_MS / 1000);
const initialDialTimeout = props.record?.dial_timeout_seconds;
const dialTimeoutInput = ref<string>(initialDialTimeout == null ? '' : String(initialDialTimeout));

const dialTimeoutParsed = computed<{ value: number | null } | { error: string }>(() => {
  const raw = dialTimeoutInput.value.trim();
  if (raw === '') return { value: null };
  if (!/^[1-9][0-9]*$/.test(raw)) return { error: 'Whole seconds, > 0' };
  const n = Number(raw);
  if (n > 600) return { error: 'Must be at most 600 seconds' };
  return { value: n };
});

// Match the URL example to the current form kind so the placeholder
// reflects what the bidirectional sync would emit for an empty form.
const urlPlaceholder = computed(() => {
  switch (config.value?.kind) {
  case 'http': return config.value.tls ? 'https://user:pass@host:443' : 'http://user:pass@host:8080';
  case 'socks5': return 'socks5://user:pass@host:1080';
  case 'ss': return 'ss://method:password@host:port';
  case 'ss2022': return 'ss://2022-blake3-aes-128-gcm:base64-key@host:port';
  case 'trojan': return 'trojan://password@host:443?sni=server.example.com';
  case 'vless-tcp': return 'vless://uuid@host:443?type=tcp&security=tls&sni=server.example.com';
  case 'vless-ws': return 'vless://uuid@host:443?type=ws&security=tls&sni=server.example.com&path=/ws';
  case 'reality': return 'vless://uuid@host:443?type=tcp&security=reality&pbk=...&sni=...&sid=...';
  default: return 'vless://uuid@host:443?...';
  }
});

const saving = ref(false);
const saveError = ref<string | null>(null);

const testing = ref(false);
const testError = ref<string | null>(null);

// Any operator edit invalidates the last Save/Test diagnostic — clear
// the banner so it reflects the current form state instead of freezing
// at the moment the operator hit Save or Test.
watch([name, url, config, dialTimeoutInput], () => {
  saveError.value = null;
  testError.value = null;
});

const deleting = ref(false);
const deleteError = ref<{ message: string; referencingUpstreamIds: string[] } | null>(null);

const backoffsForProxy = computed<BackoffRow[]>(() => {
  if (!props.record) return [];
  return proxiesStore.backoffsByProxyId.value.get(props.record.id) ?? [];
});

const upstreamNames = computed<Map<string, string>>(() => {
  const map = new Map<string, string>();
  for (const u of upstreamsStore.upstreams.value ?? []) map.set(u.id, u.name);
  return map;
});

// 1s tick to drive the backoff "in Xm Ys" countdown without a parent reload.
const now = useNow({ interval: 1000 });

const activeBackoffs = computed(() => {
  const nowSec = Math.floor(now.value.getTime() / 1000);
  // `>=` keeps the row visible during its expiry second so the countdown's
  // last tick renders the 'expiring' label. A strict `>` would hide the row
  // before the delta could go ≤ 0, leaving the edge label unreachable.
  return backoffsForProxy.value
    .filter(b => b.expires_at >= nowSec)
    .sort((a, b) => a.expires_at - b.expires_at);
});

const save = async () => {
  saveError.value = null;
  const trimmedName = name.value.trim();
  const trimmedUrl = url.value.trim();
  if (!trimmedName) { saveError.value = 'Name is required'; return; }
  if (!trimmedUrl) { saveError.value = 'URL is required'; return; }
  // Re-parse the URL we are about to submit so structural URL-grammar
  // failures (an empty REALITY pbk, a non-hex REALITY shortId) surface as
  // the same `Invalid proxy URI` save error as text typed directly into
  // the URL field. The config→url watcher zeroes urlError on every form
  // edit, so without this check a config edited via the form panel into a
  // structurally invalid state would skip past the URL-field guard.
  // Per-field semantic checks (empty Trojan/SS password, port=0) round-
  // trip cleanly through the formatter and rely on the server-side
  // config-stage validator to reject.
  const parsed = tryParse(trimmedUrl);
  if (parsed && !parsed.ok) {
    saveError.value = `Invalid proxy URI: ${parsed.error}`;
    return;
  }
  if ('error' in dialTimeoutParsed.value) {
    saveError.value = `Dial timeout: ${dialTimeoutParsed.value.error}`;
    return;
  }
  const dialTimeoutSeconds = dialTimeoutParsed.value.value;

  saving.value = true;
  try {
    if (mode.value === 'create') {
      const { error } = await callApi<ProxyRecord>(
        () => api.api.proxies.$post({ json: { name: trimmedName, url: trimmedUrl, dial_timeout_seconds: dialTimeoutSeconds } }),
      );
      if (error) { saveError.value = error.message; return; }
      emit('saved');
      open.value = false;
    } else if (props.record) {
      const { error } = await callApi(
        () => api.api.proxies[':id'].$patch({
          param: { id: props.record!.id },
          json: { name: trimmedName, url: trimmedUrl, dial_timeout_seconds: dialTimeoutSeconds },
        }),
      );
      if (error) { saveError.value = error.message; return; }
      emit('saved');
      open.value = false;
    }
  } finally {
    saving.value = false;
  }
};

const test = async () => {
  const trimmedUrl = url.value.trim();
  if (!trimmedUrl) { testError.value = 'URL is required'; return; }
  const parsed = tryParse(trimmedUrl);
  if (parsed && !parsed.ok) { testError.value = `Invalid proxy URI: ${parsed.error}`; return; }
  const dialTimeoutSeconds = 'value' in dialTimeoutParsed.value ? dialTimeoutParsed.value.value : null;

  testing.value = true;
  testError.value = null;
  try {
    const { data, error } = await callApi<{ ok: boolean; egress_ip?: string; error?: string }>(
      () => api.api.proxies.test.$post({ json: { url: trimmedUrl, dial_timeout_seconds: dialTimeoutSeconds } }),
    );
    if (error) { testError.value = error.message; return; }
    if (!data.ok || !data.egress_ip) { testError.value = data.error ?? 'Test failed'; return; }
    lastEgressIp.value = data.egress_ip;
  } finally {
    testing.value = false;
  }
};

const resetBackoff = async (upstreamId: string) => {
  if (!props.record) return;
  const { error } = await callApi(
    () => api.api.proxies[':id'].backoffs.reset.$post({
      param: { id: props.record!.id },
      json: { upstream_id: upstreamId },
    }),
  );
  if (error) { window.alert(`Reset failed: ${error.message}`); return; }
  emit('saved');
};

const resetAllBackoffs = async () => {
  if (!props.record) return;
  const { error } = await callApi(
    () => api.api.proxies[':id'].backoffs.reset.$post({
      param: { id: props.record!.id },
      json: {},
    }),
  );
  if (error) { window.alert(`Reset failed: ${error.message}`); return; }
  emit('saved');
};

const remove = async () => {
  if (!props.record) return;
  if (!window.confirm(`Delete proxy "${props.record.name}"?`)) return;

  deleting.value = true;
  deleteError.value = null;
  try {
    const { error } = await callApi(
      () => api.api.proxies[':id'].$delete({ param: { id: props.record!.id } }),
    );
    if (error) {
      if (error.status === 409) {
        const refs = (error.raw as ProxyConflictBody | undefined)?.referencing_upstream_ids ?? [];
        deleteError.value = {
          message: 'Cannot delete: referenced by upstream(s)',
          referencingUpstreamIds: refs,
        };
        return;
      }
      deleteError.value = { message: error.message, referencingUpstreamIds: [] };
      return;
    }
    emit('saved');
    open.value = false;
  } finally {
    deleting.value = false;
  }
};

const title = computed(() => mode.value === 'create' ? 'Create Proxy' : `Edit Proxy: ${props.record?.name ?? ''}`);
</script>

<template>
  <Dialog v-model:open="open" :title="title" size="xl">
    <div class="space-y-5">
      <p v-if="saveError" class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
        {{ saveError }}
      </p>

      <div class="space-y-1.5">
        <label class="block text-xs font-medium text-gray-500">Name</label>
        <Input v-model="name" placeholder="My JP server" />
      </div>

      <div class="space-y-4">
        <div class="space-y-1.5">
          <label class="block text-xs font-medium text-gray-500">URL</label>
          <Input
            v-model="url"
            :placeholder="urlPlaceholder"
            :invalid="urlError !== null"
            class="font-mono"
          />
          <div v-if="urlError" class="inline-flex items-center gap-1 rounded-md border border-accent-rose/30 bg-accent-rose/10 px-2 py-1 text-xs text-accent-rose">
            <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
            {{ urlError }}
          </div>
        </div>
        <ProxyConfigForm
          v-if="config"
          v-model="config"
          :url-error="urlError"
        />
        <div class="flex flex-wrap items-center gap-2 pt-1 text-xs text-gray-500">
          <span>Egress:</span>
          <span v-if="lastEgressIp" class="font-mono text-gray-300">{{ lastEgressIp }}</span>
          <Button variant="secondary" size="sm" :loading="testing" :disabled="saving" @click="test">Test</Button>
        </div>
        <p v-if="testError" class="text-xs text-accent-rose">{{ testError }}</p>
      </div>

      <div class="space-y-1.5">
        <label class="block text-xs font-medium text-gray-500">
          Dial timeout <span class="text-gray-600">(seconds, leave empty for default)</span>
        </label>
        <Input
          v-model="dialTimeoutInput"
          :placeholder="`${DEFAULT_DIAL_TIMEOUT_SECONDS} (default)`"
          :invalid="'error' in dialTimeoutParsed"
          inputmode="numeric"
          class="font-mono"
        />
        <p v-if="'error' in dialTimeoutParsed" class="text-xs text-accent-rose">{{ dialTimeoutParsed.error }}</p>
        <p v-else class="text-xs text-gray-600">
          Hard ceiling on TCP-connect + handshake time before the fallback chain advances and the proxy enters backoff.
        </p>
      </div>

      <template v-if="mode === 'edit' && record">
        <section v-if="activeBackoffs.length > 0">
          <div class="mb-2 flex items-center justify-between">
            <h3 class="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              Backoff state <span class="text-accent-amber">({{ activeBackoffs.length }})</span>
            </h3>
            <button
              v-if="activeBackoffs.length > 1"
              type="button"
              class="text-xs text-gray-400 transition-colors hover:text-accent-rose"
              @click="resetAllBackoffs"
            >Reset all</button>
          </div>
          <div class="space-y-1.5">
            <div
              v-for="row in activeBackoffs"
              :key="row.upstream_id"
              class="flex items-center gap-3 rounded-md border border-white/5 bg-surface-800/40 px-3 py-2"
            >
              <span class="min-w-0 flex-1 truncate text-sm text-gray-300" :title="row.last_error ?? undefined">
                {{ upstreamNames.get(row.upstream_id) ?? row.upstream_id }}
              </span>
              <span class="text-xs text-accent-amber tabular-nums">in {{ formatCountdown(row.expires_at * 1000 - now.getTime(), 'expiring') }}</span>
              <span class="text-xs text-gray-500">fail #{{ row.fail_count }}</span>
              <button
                type="button"
                class="text-xs text-gray-400 transition-colors hover:text-accent-rose"
                @click="resetBackoff(row.upstream_id)"
              >Reset</button>
            </div>
          </div>
        </section>
      </template>

      <div class="flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-5">
        <Button :loading="saving" :disabled="testing" @click="save">Save</Button>
        <Button variant="secondary" :disabled="saving" @click="open = false">Cancel</Button>

        <template v-if="mode === 'edit' && record">
          <Button variant="danger" class="ml-auto" :loading="deleting" @click="remove">Delete</Button>
        </template>
      </div>

      <div v-if="deleteError" class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
        <p>{{ deleteError.message }}<template v-if="deleteError.referencingUpstreamIds.length === 0">.</template></p>
        <p v-if="deleteError.referencingUpstreamIds.length > 0" class="mt-1 text-xs">
          <template v-for="(id, idx) in deleteError.referencingUpstreamIds" :key="id">
            <RouterLink :to="`/dashboard/upstreams/${id}`" class="underline transition-colors hover:text-white">
              {{ upstreamNames.get(id) ?? id }}
            </RouterLink>
            <span v-if="idx < deleteError.referencingUpstreamIds.length - 1">, </span>
          </template>
        </p>
      </div>
    </div>
  </Dialog>
</template>
