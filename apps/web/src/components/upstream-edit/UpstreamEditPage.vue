<script setup lang="ts">
// Owns the entire draft state (provider, name, enabled, flag overrides,
// disabled model ids, plus the provider-specific custom/azure drafts) and
// the live /models fetch for custom upstreams.

import type { InferRequestType } from 'hono/client';
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';

import {
  type AzureDraft,
  blankAzureDraft,
  blankCustomDraft,
  blankOllamaDraft,
  buildCustomConfigCore,
  type CustomDraft,
  type OllamaDraft,
  seedPathOverrides,
} from './customConfig.ts';
import ModelsPanel from './ModelsPanel.vue';
import UpstreamConfigPanel from './UpstreamConfigPanel.vue';
import { authFetch, callApi, useApi } from '../../api/client.ts';
import type { CopilotQuotaSnapshot, CursorDashboardUsage, CustomRawModel, FlagDef, ModelEndpoints, ModelPrefixConfig, OllamaUpstreamConfig, ProxyFallbackEntry, UpstreamModelConfig, UpstreamProviderKind, UpstreamRecord } from '../../api/types.ts';
import { useRuntimeInfo } from '../../composables/useRuntimeInfo.ts';
import { useUpstreamsStore } from '../../composables/useUpstreams.ts';
import { providerMeta } from '../upstreams/provider-meta.ts';
import { Button } from '@floway-dev/ui';

type CommonPageProps = {
  nextSortOrder: number;
  flags: FlagDef[];
  // Resolved model list pre-fetched by the route loader from
  // /upstreams/:id/models for non-Azure providers (copilot, codex, and
  // custom in edit mode). Empty array means "no record yet, Azure, or the
  // fetch failed" — the matching error field carries the reason.
  initialUpstreamModels?: UpstreamModelConfig[];
  initialUpstreamModelsError?: string | null;
  initialCopilotQuota?: CopilotQuotaSnapshot | null;
  initialCopilotQuotaError?: string | null;
  initialCursorQuota?: CursorDashboardUsage | null;
  initialCursorQuotaError?: string | null;
};

const props = defineProps<
  | (CommonPageProps & {
    mode: 'create';
    record: null;
    // Default provider for create mode; ignored in edit mode (taken from record).
    initialKind: UpstreamProviderKind;
  })
  | (CommonPageProps & {
    mode: 'edit';
    record: UpstreamRecord;
    initialKind?: undefined;
  })
>();

const emit = defineEmits<{
  saved: [record: UpstreamRecord | null];
}>();

const router = useRouter();
const api = useApi();
const upstreamsStore = useUpstreamsStore();
const { info: runtimeInfo } = useRuntimeInfo();
const coloAware = computed(() => runtimeInfo.value?.kind === 'cloudflare');
const currentColo = computed(() => runtimeInfo.value?.colo ?? null);

type CreateBody = InferRequestType<typeof api.api.upstreams.$post>['json'];
type PatchBody = InferRequestType<(typeof api.api.upstreams)[':id']['$patch']>['json'];

// Edit mode: provider follows the record. Create mode: locked in by the
// route param at mount time.
const activeKind = computed<UpstreamProviderKind>(() => props.mode === 'edit' ? props.record.kind : props.initialKind);

// Discriminated (mode, record) pair forwarded to UpstreamConfigPanel. The
// page's own union already guarantees this shape; the explicit pairing
// re-narrows for the template binding so Vue's prop-type check accepts it
// alongside the live `liveRecord` ref (which is typed as `UpstreamRecord | null`
// since it must survive a brief null window during `upstreamsStore.load()`).
const modeRecord = computed<{ mode: 'create'; record: null } | { mode: 'edit'; record: UpstreamRecord }>(
  () => liveRecord.value && props.mode === 'edit'
    ? { mode: 'edit', record: liveRecord.value }
    : { mode: 'create', record: null },
);
const name = ref('');
const enabled = ref(true);
const sortOrder = ref<number>(props.nextSortOrder);
const flagOverrides = ref<Record<string, boolean>>({});
const disabledPublicModelIds = ref<string[]>([]);
const proxyFallbackList = ref<ProxyFallbackEntry[]>([]);
const modelPrefix = ref<ModelPrefixConfig | null>(null);
const modelPrefixInvalid = ref(false);
const customDraft = ref<CustomDraft>(blankCustomDraft());
const azureDraft = ref<AzureDraft>(blankAzureDraft());
const ollamaDraft = ref<OllamaDraft>(blankOllamaDraft());
// Cursor privacy toggle persisted via the page Save button (maxMode /
// tabCompletion are edited inline in CursorConfigPanel). Absent on the
// record = privacy on.
const cursorPrivacyMode = ref(true);

const upstreamModels = ref<UpstreamModelConfig[]>(props.initialUpstreamModels ?? []);
const upstreamModelsError = ref<string | null>(props.initialUpstreamModelsError ?? null);

// `props.record` is a snapshot the loader resolved against the store's array
// at route-resolution time; once `upstreamsStore.load()` rebuilds that array
// with brand-new objects (e.g. after a forced cache refresh), the snapshot's
// `modelsCache` summary goes stale. Mirror it locally and re-seed from the
// store after every reload so `ModelsCacheStatus` reflects the row the
// gateway just rewrote.
const liveRecord = ref<UpstreamRecord | null>(props.record);
watch(() => props.record, r => { liveRecord.value = r; });

const seedFromRecord = (r: UpstreamRecord) => {
  name.value = r.name;
  enabled.value = r.enabled;
  sortOrder.value = r.sort_order;
  flagOverrides.value = { ...r.flag_overrides };
  disabledPublicModelIds.value = [...r.disabled_public_model_ids];
  proxyFallbackList.value = r.proxy_fallback_list.map(e => ({ id: e.id, ...(e.colos ? { colos: [...e.colos] } : {}) }));
  modelPrefix.value = r.model_prefix === null
    ? null
    : {
        prefix: r.model_prefix.prefix,
        addressable: [...r.model_prefix.addressable],
        listed: [...r.model_prefix.listed],
      };

  if (r.kind === 'custom') {
    const cfg = r.config;
    customDraft.value = {
      baseUrl: cfg.baseUrl,
      authStyle: cfg.authStyle,
      endpoints: { ...cfg.endpoints },
      apiKey: '',
      pathOverrides: seedPathOverrides(cfg.pathOverrides),
      modelsFetch: cfg.modelsFetch
        ? { enabled: cfg.modelsFetch.enabled, endpoint: cfg.modelsFetch.endpoint ?? '' }
        : { enabled: true, endpoint: '' },
      // r.config is reactive (props passthrough); structuredClone refuses Vue
      // Proxies in Chromium and toRaw only unwraps the top layer. The models
      // tree is plain data, so a JSON round-trip is the cheapest way to land a
      // deep, proxy-free copy that the field can mutate freely.
      models: cfg.models ? (JSON.parse(JSON.stringify(cfg.models)) as UpstreamModelConfig[]) : [],
    };
  } else if (r.kind === 'azure') {
    const cfg = r.config;
    azureDraft.value = {
      endpoint: cfg.endpoint,
      apiKey: '',
      models: cfg.models ? (JSON.parse(JSON.stringify(cfg.models)) as UpstreamModelConfig[]) : [],
    };
  } else if (r.kind === 'ollama') {
    const cfg = r.config;
    ollamaDraft.value = {
      baseUrl: cfg.baseUrl,
      apiKey: '',
      models: cfg.models ? (JSON.parse(JSON.stringify(cfg.models)) as UpstreamModelConfig[]) : [],
    };
  } else if (r.kind === 'cursor') {
    cursorPrivacyMode.value = r.config.privacyMode ?? true;
  }
};

const seedFresh = () => {
  name.value = providerMeta(activeKind.value).defaultName;
  enabled.value = true;
  sortOrder.value = props.nextSortOrder;
  flagOverrides.value = {};
  disabledPublicModelIds.value = [];
  proxyFallbackList.value = [];
  modelPrefix.value = null;
  customDraft.value = blankCustomDraft();
  azureDraft.value = blankAzureDraft();
  ollamaDraft.value = blankOllamaDraft();
};

if (props.mode === 'edit') seedFromRecord(props.record);
else seedFresh();

const customApiKeySet = computed(() => {
  if (props.record?.kind !== 'custom') return false;
  return props.record.config.apiKeySet === true;
});
const azureApiKeySet = computed(() => {
  if (props.record?.kind !== 'azure') return false;
  return props.record.config.apiKeySet === true;
});
const ollamaApiKeySet = computed(() => {
  const cfg = props.record?.config as OllamaUpstreamConfig | undefined;
  return cfg?.apiKeySet === true;
});

// Create-mode draft preview state for the inline "Fetch" button on the
// Custom and Ollama panels: POST /upstreams/fetch-models renders the unsaved
// config's catalog so the operator can pick rows before saving. Saved
// upstreams flow through the unified GET path and `upstreamModels` instead.
// `fetchedRaw` carries the Custom raw rows (translated through the draft's
// endpoints by `customAutoModelsFromDraft`); `fetchedOllamaModels` carries
// the Ollama rows the backend already projected — no further translation
// needed since the per-model endpoints fall out of upstream capabilities.
const fetchedRaw = ref<CustomRawModel[]>([]);
const fetchedOllamaModels = ref<UpstreamModelConfig[]>([]);
const fetchLoading = ref(false);
const fetchError = ref<string | null>(null);
const fetchedAtMs = ref<number | null>(null);
const fetchedCount = ref(0);

// A custom raw model carries no per-endpoint hint beyond its kind. Embedding
// and image map to their fixed endpoints; chat models follow the
// upstream-level Default LLM Endpoints selection, mirroring how the data
// plane derives an auto chat model's endpoints from the per-upstream config.
const endpointsForKind = (kind: CustomRawModel['kind']): ModelEndpoints => {
  if (kind === 'embedding') return { embeddings: {} };
  if (kind === 'image') return { imagesGenerations: {}, imagesEdits: {} };
  return Object.keys(customDraft.value.endpoints).length > 0
    ? { ...customDraft.value.endpoints }
    : { chatCompletions: {} };
};

const customAutoModelsFromDraft = computed<UpstreamModelConfig[]>(() => fetchedRaw.value.map(m => {
  const label = m.display_name ?? m.name;
  return {
    upstreamModelId: m.id,
    publicModelId: m.id,
    kind: m.kind ?? 'chat',
    endpoints: endpointsForKind(m.kind),
    ...(label ? { display_name: label } : {}),
    ...(m.limits ? { limits: m.limits } : {}),
    ...(m.cost ? { cost: m.cost } : {}),
  };
}));

const fetchDraftModels = async () => {
  if (props.mode !== 'create') return;
  fetchLoading.value = true;
  fetchError.value = null;
  try {
    if (activeKind.value === 'custom') {
      const { data, error } = await callApi<{ data: CustomRawModel[] }>(
        () => api.api.upstreams['fetch-models'].$post({
          json: { kind: 'custom', config: { ...buildCustomConfigCore(customDraft.value), models: customDraft.value.models } },
        }),
      );
      // The toggle may have been turned off while this request was in flight;
      // with fetch disabled the auto block is hidden and dropped on save, so
      // discard the late result rather than repopulating stale auto rows.
      if (!customDraft.value.modelsFetch.enabled) return;
      if (error) { fetchError.value = error.message; return; }
      fetchedRaw.value = data.data;
      fetchedCount.value = data.data.length;
      fetchedAtMs.value = Date.now();
    } else if (activeKind.value === 'ollama') {
      type FetchModelsBody = InferRequestType<typeof api.api.upstreams['fetch-models']['$post']>['json'];
      type OllamaFetchConfig = Extract<FetchModelsBody, { kind: 'ollama' }>['config'];
      const config: OllamaFetchConfig = {
        baseUrl: ollamaDraft.value.baseUrl.trim(),
        models: ollamaDraft.value.models,
      };
      if (ollamaDraft.value.apiKey.trim()) config.apiKey = ollamaDraft.value.apiKey.trim();
      const { data, error } = await callApi<{ data: UpstreamModelConfig[] }>(
        () => api.api.upstreams['fetch-models'].$post({ json: { kind: 'ollama', config } }),
      );
      if (error) { fetchError.value = error.message; return; }
      fetchedOllamaModels.value = data.data;
      fetchedCount.value = data.data.length;
      fetchedAtMs.value = Date.now();
    }
  } finally {
    fetchLoading.value = false;
  }
};

watch(() => customDraft.value.modelsFetch.enabled, on => {
  if (!on) {
    fetchedRaw.value = [];
    fetchError.value = null;
    fetchedAtMs.value = null;
    fetchedCount.value = 0;
  }
});

const fetchStatus = computed<string | null>(() => {
  if (fetchLoading.value) return 'fetching…';
  if (fetchedAtMs.value === null) return null;
  const ago = Math.max(0, Date.now() - fetchedAtMs.value);
  const mins = Math.floor(ago / 60000);
  const label = mins < 1 ? 'just now' : `${mins}m ago`;
  return `${fetchedCount.value} returned · ${label}`;
});

const refreshing = ref(false);
const refreshCachedModels = async () => {
  if (!props.record || props.record.kind === 'azure') return;
  refreshing.value = true;
  upstreamModelsError.value = null;
  try {
    // The route's query is unvalidated server-side, so the typed client
    // does not surface a `query` arg. Resolve the path with `$path` (the
    // sibling `$url` returns a `URL` that the relative `/` base of `hc('/')`
    // cannot construct), then append the toggle.
    const path = api.api.upstreams[':id'].models.$path({ param: { id: props.record.id } });
    const { data, error } = await callApi<{ data: UpstreamModelConfig[] }>(() => authFetch(`${path}?refresh=true`));
    if (error) {
      upstreamModelsError.value = error.message;
      return;
    }
    upstreamModels.value = data.data;
  } finally {
    // Reload the upstream list so `modelsCache.fetchedAt` and `lastError`
    // reflect the row the gateway just rewrote, regardless of outcome. The
    // store rebuilds `upstreams` with fresh objects, so re-read the row
    // from it and push the new snapshot into `liveRecord` — the loader's
    // original `props.record` reference would otherwise stay stale.
    await upstreamsStore.load();
    const refreshed = upstreamsStore.upstreams.value?.find(u => u.id === props.record!.id) ?? null;
    if (refreshed) liveRecord.value = refreshed;
    refreshing.value = false;
  }
};

const saving = ref(false);
const saveError = ref<string | null>(null);
const modelsPanelInvalid = ref(false);

const buildCustomConfig = (): Extract<CreateBody, { kind: 'custom' }>['config'] => {
  const config: Extract<CreateBody, { kind: 'custom' }>['config'] = {
    ...buildCustomConfigCore(customDraft.value),
    models: customDraft.value.models,
  };
  const overrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(customDraft.value.pathOverrides)) {
    const trimmed = v.trim();
    if (trimmed) overrides[k] = trimmed;
  }
  if (Object.keys(overrides).length > 0) config.pathOverrides = overrides;
  else if (props.mode === 'edit') config.pathOverrides = null;
  return config;
};

const buildAzureConfig = (): Extract<CreateBody, { kind: 'azure' }>['config'] => {
  const config: Extract<CreateBody, { kind: 'azure' }>['config'] = {
    endpoint: azureDraft.value.endpoint.trim(),
    models: azureDraft.value.models,
  };
  if (azureDraft.value.apiKey.trim()) config.apiKey = azureDraft.value.apiKey.trim();
  return config;
};

const buildOllamaConfig = (): Extract<CreateBody, { kind: 'ollama' }>['config'] => {
  const config: Extract<CreateBody, { kind: 'ollama' }>['config'] = {
    baseUrl: ollamaDraft.value.baseUrl.trim(),
    models: ollamaDraft.value.models,
  };
  if (ollamaDraft.value.apiKey.trim()) config.apiKey = ollamaDraft.value.apiKey.trim();
  return config;
};

const baseFields = () => ({
  name: name.value.trim(),
  enabled: enabled.value,
  sort_order: sortOrder.value,
  flag_overrides: flagOverrides.value,
  disabled_public_model_ids: disabledPublicModelIds.value,
  proxy_fallback_list: proxyFallbackList.value,
  model_prefix: modelPrefix.value,
});

const save = async () => {
  saveError.value = null;
  const trimmedName = name.value.trim();
  if (!trimmedName) { saveError.value = 'Name is required'; return; }
  if (modelPrefixInvalid.value) { saveError.value = 'Model name prefix is invalid'; return; }
  if (modelsPanelInvalid.value) { saveError.value = 'One or more models have invalid configuration — check model reasoning settings'; return; }

  saving.value = true;
  try {
    if (props.mode === 'create') {
      let body: CreateBody;
      if (activeKind.value === 'custom') {
        body = { kind: 'custom', ...baseFields(), config: buildCustomConfig() };
      } else if (activeKind.value === 'azure') {
        body = { kind: 'azure', ...baseFields(), config: buildAzureConfig() };
      } else if (activeKind.value === 'ollama') {
        body = { kind: 'ollama', ...baseFields(), config: buildOllamaConfig() };
      } else {
        // Unreachable: see showSaveButton.
        saveError.value = `${activeKind.value} upstreams are created through their dedicated panel.`;
        return;
      }
      const { data, error } = await callApi<UpstreamRecord>(() => api.api.upstreams.$post({ json: body }));
      if (error) { saveError.value = error.message; return; }
      emit('saved', data);
    } else {
      const patch: PatchBody = baseFields();
      if (activeKind.value === 'custom') patch.config = buildCustomConfig();
      else if (activeKind.value === 'azure') patch.config = buildAzureConfig();
      else if (activeKind.value === 'ollama') patch.config = buildOllamaConfig();
      else if (activeKind.value === 'cursor') patch.config = { privacyMode: cursorPrivacyMode.value };
      const { error } = await callApi(
        () => api.api.upstreams[':id'].$patch({ param: { id: props.record.id }, json: patch }),
      );
      if (error) { saveError.value = error.message; return; }
      emit('saved', props.record);
    }
    await router.push('/dashboard/settings');
  } finally {
    saving.value = false;
  }
};

const cancel = async () => {
  await router.push('/dashboard/settings');
};

const onImported = async (newRecord: UpstreamRecord) => {
  emit('saved', newRecord);
  await router.replace(`/dashboard/upstreams/${newRecord.id}`);
};

// Quota refresh is data-only: the gateway persisted the new
// `usageProbeSnapshot` slot and the panel handed us a locally-merged record.
// Land it on `liveRecord` so AccountCard re-renders, but do not emit `saved`
// or navigate — neither the route nor the store list view changes.
const onClaudeCodeQuotaRefreshed = (newRecord: UpstreamRecord) => {
  liveRecord.value = newRecord;
};

const onImportError = (message: string) => {
  saveError.value = message;
};

// Read-only providers never invoke the v-model setter; the getter returns [] to satisfy the type contract.
const modelsManualForActive = computed<UpstreamModelConfig[]>({
  get: () => {
    if (activeKind.value === 'custom') return customDraft.value.models;
    if (activeKind.value === 'azure') return azureDraft.value.models;
    if (activeKind.value === 'ollama') return ollamaDraft.value.models;
    return [];
  },
  set: next => {
    if (activeKind.value === 'custom') customDraft.value = { ...customDraft.value, models: next };
    else if (activeKind.value === 'azure') azureDraft.value = { ...azureDraft.value, models: next };
    else if (activeKind.value === 'ollama') ollamaDraft.value = { ...ollamaDraft.value, models: next };
  },
});

// Auto rows are the live catalog the upstream itself decides. For copilot,
// codex, claude-code, and saved custom/ollama upstreams that comes from the
// SWR cache via `upstreamModels`. Create-mode custom and ollama drafts fall
// back to the inline POST /fetch-models preview — custom rows are translated
// through the draft's endpoints; ollama rows arrive already projected. Azure
// has no auto rows (the loader does not fetch for it), so `upstreamModels`
// is empty and the same fall-through is correct.
const autoForActive = computed<UpstreamModelConfig[]>(() => {
  if (activeKind.value === 'custom') {
    if (!customDraft.value.modelsFetch.enabled) return [];
    if (props.mode === 'edit') return upstreamModels.value;
    return customAutoModelsFromDraft.value;
  }
  if (activeKind.value === 'ollama') {
    if (props.mode === 'edit') return upstreamModels.value;
    return fetchedOllamaModels.value;
  }
  return upstreamModels.value;
});

const upstreamIdLabelForActive = computed(() => activeKind.value === 'azure' ? 'Deployment' : 'Upstream Model ID');
// Provider import panels (copilot/codex/claude-code) land the row themselves on create, so the page-level Save button stays hidden until they emit.
const showSaveButton = computed(() => props.mode === 'edit' || (activeKind.value !== 'copilot' && activeKind.value !== 'codex' && activeKind.value !== 'claude-code' && activeKind.value !== 'cursor'));

// The cache-status panel reads the row's `modelsCache` summary and offers a
// force-refresh shortcut. Azure is the one provider whose catalog is pure
// form data — there is nothing the gateway can fetch — so the panel is
// suppressed for it.
const showCacheStatus = computed(() => props.mode === 'edit' && props.record !== null && props.record.kind !== 'azure');

// Public-id catalogue feeding the disabled-models combobox: every model
// currently surfaced for this provider, deduped by public id. A model's
// public id is its publicModelId override when set, otherwise its
// upstreamModelId — same rule the data plane filters by.
const availableModelItems = computed<{ value: string; label: string }[]>(() => {
  const seen = new Set<string>();
  const items: { value: string; label: string }[] = [];
  const collect = (list: UpstreamModelConfig[]) => {
    for (const m of list) {
      // `||` (not `??`) is intentional: a whitespace-only override should
      // not shadow the upstream id.
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      const id = m.publicModelId?.trim() || m.upstreamModelId;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ value: id, label: id });
    }
  };
  collect(modelsManualForActive.value);
  collect(autoForActive.value);
  return items;
});

// Measure the right pane's intrinsic content height (sum of its children, not
// the root, which the grid stretches). The aside caps its max-h at this value
// so the rail and the editor reach the same bottom; the cap is overridden by
// the aside's own intrinsic-floor min-h when the rail's children would not
// otherwise fit (see UpstreamConfigPanel).
const modelsPanelRef = useTemplateRef<{ $el: HTMLElement } | null>('modelsPanelRef');
const rightContentH = ref(0);
let rightObserver: ResizeObserver | undefined;
const measureRight = () => {
  const root = modelsPanelRef.value?.$el;
  if (!root) return;
  const kids = Array.from(root.children) as HTMLElement[];
  let h = 0;
  for (const k of kids) h += k.getBoundingClientRect().height;
  const gap = parseFloat(getComputedStyle(root).rowGap);
  if (kids.length > 1) h += gap * (kids.length - 1);
  rightContentH.value = h;
};
watch(() => modelsPanelRef.value?.$el, root => {
  rightObserver?.disconnect();
  if (!root) return;
  rightObserver = new ResizeObserver(measureRight);
  for (const k of Array.from(root.children) as HTMLElement[]) rightObserver.observe(k);
  measureRight();
}, { immediate: true, flush: 'post' });
onBeforeUnmount(() => rightObserver?.disconnect());
const workbenchStyle = computed(() => ({ '--right-pane-h': `${Math.ceil(rightContentH.value)}px` }));
</script>

<template>
  <div>
    <header class="mb-5 flex flex-wrap items-center gap-3">
      <nav class="flex items-center gap-2 text-sm text-gray-500">
        <RouterLink to="/dashboard/settings" class="hover:text-gray-300">Settings</RouterLink>
        <span class="text-white/15">/</span>
        <RouterLink to="/dashboard/settings" class="hover:text-gray-300">Upstreams</RouterLink>
        <span class="text-white/15">/</span>
        <span v-if="record" class="font-semibold text-white">{{ record.name }}</span>
        <span v-else class="font-semibold text-white">New upstream</span>
      </nav>
      <div class="ml-auto flex items-center gap-2">
        <Button variant="secondary" :disabled="saving" @click="cancel">Cancel</Button>
        <Button v-if="showSaveButton" :loading="saving" @click="save">Save changes</Button>
      </div>
    </header>

    <p v-if="saveError" class="mb-4 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">{{ saveError }}</p>
    <p v-if="upstreamModelsError" class="mb-4 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">Failed to fetch upstream model list: {{ upstreamModelsError }}</p>

    <!-- Two-column workbench. Default behavior: aside max-h matches the
         right pane (or viewport, whichever is taller) so the rail and the
         editor reach the same bottom; flag editor flex-1 + OverlayScrollbars
         soaks up internal slack. The cap is OVERRIDDEN by the aside's
         intrinsic-floor min-h (computed inside UpstreamConfigPanel: every
         non-flag section's height + flag editor's min-h-[16rem]) so when
         the other sections plus the flag editor's minimum would not fit
         under the cap, the aside grows past it. The rail itself never
         clips or scrolls; the page does. -->
    <div :style="workbenchStyle" class="grid grid-cols-1 gap-5 lg:grid-cols-[400px_minmax(0,1fr)]">
      <UpstreamConfigPanel
        v-bind="modeRecord"
        :kind="activeKind"
        v-model:name="name"
        v-model:enabled="enabled"
        v-model:flag-overrides="flagOverrides"
        v-model:disabled-ids="disabledPublicModelIds"
        v-model:proxy-fallback-list="proxyFallbackList"
        v-model:model-prefix="modelPrefix"
        @update:model-prefix-invalid="v => modelPrefixInvalid = v"
        v-model:custom="customDraft"
        v-model:azure="azureDraft"
        v-model:ollama="ollamaDraft"
        v-model:cursor-privacy-mode="cursorPrivacyMode"
        :flags="flags"
        :colo-aware="coloAware"
        :current-colo="currentColo"
        :custom-api-key-set="customApiKeySet"
        :azure-api-key-set="azureApiKeySet"
        :ollama-api-key-set="ollamaApiKeySet"
        :fetch-loading="fetchLoading"
        :fetch-error="fetchError"
        :fetch-status="fetchStatus"
        :available-model-items="availableModelItems"
        :initial-copilot-quota="initialCopilotQuota"
        :initial-copilot-quota-error="initialCopilotQuotaError"
        :initial-cursor-quota="initialCursorQuota"
        :initial-cursor-quota-error="initialCursorQuotaError"
        :models-cache="showCacheStatus ? liveRecord!.modelsCache : null"
        :refreshing="refreshing"
        @fetch-models="fetchDraftModels"
        @refresh-cache="refreshCachedModels"
        @imported="onImported"
        @error="onImportError"
        @claude-code-quota-refreshed="onClaudeCodeQuotaRefreshed"
      />
      <ModelsPanel
        ref="modelsPanelRef"
        v-model="modelsManualForActive"
        v-model:disabled-ids="disabledPublicModelIds"
        :auto-models="autoForActive"
        :flags="flags"
        :upstream-flag-overrides="flagOverrides"
        :flag-provider-kind="activeKind"
        :upstream-id-label="upstreamIdLabelForActive"
        :read-only="activeKind === 'copilot' || activeKind === 'codex' || activeKind === 'claude-code' || activeKind === 'cursor'"
        :all-manual="activeKind === 'azure'"
        @update:invalid="v => modelsPanelInvalid = v"
      />
    </div>
  </div>
</template>
