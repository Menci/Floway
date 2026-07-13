<script setup lang="ts">
// Owns the entire draft state (provider, name, enabled, flag overrides,
// disabled model ids, plus the provider-specific custom/azure/ollama
// drafts) and the live /models fetch for custom upstreams. Create and
// edit share this component — the sole differentiator is
// `draft.id === ''`, which selects POST vs PATCH at save time.

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
import { callApi, useApi } from '../../api/client.ts';
import type { AzureUpstreamConfig, CustomRawModel, CustomUpstreamConfig, ModelEndpoints, OllamaUpstreamConfig, UpstreamModelConfig, UpstreamRecord } from '../../api/types.ts';
import { toRecordEnvelope } from '../../api/types.ts';
import { useRuntimeInfo } from '../../composables/useRuntimeInfo.ts';
import { useUpstreamsStore } from '../../composables/useUpstreams.ts';
import type { Flag, FlagOverrides } from '@floway-dev/provider/flags';
import { Button } from '@floway-dev/ui';

const props = defineProps<{
  initialRecord: UpstreamRecord;
  flags: Flag[];
}>();

const emit = defineEmits<{
  saved: [record: UpstreamRecord];
}>();

const router = useRouter();
const api = useApi();
const upstreamsStore = useUpstreamsStore();
const { info: runtimeInfo } = useRuntimeInfo();
const coloAware = computed(() => runtimeInfo.value?.kind === 'cloudflare');
const currentColo = computed(() => runtimeInfo.value?.runtimeLocation ?? null);

// The single source of truth: draft is a mutable structuredClone of the
// initial record. Every field in the form binds through this ref (either
// via computed get/set or via the per-provider *Draft mirrors below).
const draft = ref<UpstreamRecord>(structuredClone(props.initialRecord));

const isCreate = computed(() => draft.value.id === '');

// Provider-specific form-UX drafts. These mirror the record's config but
// hold form-only state — most importantly, `apiKey` starts as '' on
// mount even when the record carries a real value, so the "type to
// overwrite; empty means keep-existing" behavior stays consistent
// everywhere. They project back into draft.config via
// buildCustomConfig / … at save.
const customDraft = ref<CustomDraft>(blankCustomDraft());
const azureDraft = ref<AzureDraft>(blankAzureDraft());
const ollamaDraft = ref<OllamaDraft>(blankOllamaDraft());

const seedProviderDrafts = () => {
  if (draft.value.kind === 'custom') {
    const cfg: CustomUpstreamConfig = draft.value.config;
    customDraft.value = {
      baseUrl: cfg.baseUrl,
      authStyle: cfg.authStyle,
      endpoints: { ...cfg.endpoints },
      apiKey: '',
      pathOverrides: seedPathOverrides(cfg.pathOverrides),
      modelsFetch: cfg.modelsFetch
        ? { enabled: cfg.modelsFetch.enabled, endpoint: cfg.modelsFetch.endpoint ?? '' }
        : { enabled: true, endpoint: '' },
      // JSON round-trip clones the models array: `structuredClone` refuses
      // Vue's reactive Proxy over `ref().value`, and `toRaw` only unwraps the
      // top layer. The top-level `draft` ref seeded with `structuredClone`
      // works because props aren't proxied — different call sites, different
      // constraints.
      models: JSON.parse(JSON.stringify(cfg.models)) as UpstreamModelConfig[],
    };
  } else if (draft.value.kind === 'azure') {
    const cfg: AzureUpstreamConfig = draft.value.config;
    azureDraft.value = {
      endpoint: cfg.endpoint,
      apiKey: '',
      // Azure requires a non-empty models array on save; when the blueprint
      // seeds an empty list, keep the blankAzureDraft's default row.
      models: cfg.models.length > 0
        ? (JSON.parse(JSON.stringify(cfg.models)) as UpstreamModelConfig[])
        : blankAzureDraft().models,
    };
  } else if (draft.value.kind === 'ollama') {
    const cfg: OllamaUpstreamConfig = draft.value.config;
    ollamaDraft.value = {
      baseUrl: cfg.baseUrl,
      apiKey: '',
      models: JSON.parse(JSON.stringify(cfg.models)) as UpstreamModelConfig[],
    };
  }
};
seedProviderDrafts();

// Every top-level user-owned field surfaces through a computed pair so the
// template's v-models bind straight to `draft` without a separate ref
// mirror per field. Setting the computed mutates the draft in place;
// getting it observes any patch merged in by a wizard.
const name = computed<string>({ get: () => draft.value.name, set: v => { draft.value = { ...draft.value, name: v }; } });
const enabled = computed<boolean>({ get: () => draft.value.enabled, set: v => { draft.value = { ...draft.value, enabled: v }; } });
const flagOverrides = computed<FlagOverrides>({
  get: () => draft.value.flag_overrides,
  set: v => { draft.value = { ...draft.value, flag_overrides: v }; },
});
const disabledPublicModelIds = computed<string[]>({
  get: () => draft.value.disabled_public_model_ids,
  set: v => { draft.value = { ...draft.value, disabled_public_model_ids: v }; },
});
const proxyFallbackList = computed({
  get: () => draft.value.proxy_fallback_list,
  set: v => { draft.value = { ...draft.value, proxy_fallback_list: v }; },
});
const modelPrefix = computed({
  get: () => draft.value.model_prefix,
  set: v => { draft.value = { ...draft.value, model_prefix: v }; },
});
const modelPrefixInvalid = ref(false);
const color = computed({
  get: () => draft.value.color,
  set: v => { draft.value = { ...draft.value, color: v }; },
});
const colorInvalid = ref(false);

const upstreamModels = ref<UpstreamModelConfig[]>([]);
const upstreamModelsError = ref<string | null>(null);

// Create-mode draft preview state for the inline "Fetch" button on the
// Custom and Ollama panels: `POST /api/upstreams/list-models` returns the
// unsaved config's catalog so rows can be picked before saving.
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
    ...(m.pricing ? { pricing: m.pricing } : {}),
  };
}));

// The unified list-models endpoint: custom returns raw rows the dashboard
// translates through the draft's endpoints; every other kind returns
// already-projected `UpstreamModelConfig`.
type ListModelsResult = { data: UpstreamModelConfig[] } | { data: CustomRawModel[] };

const listDraftModels = async () => {
  if (draft.value.kind !== 'custom' && draft.value.kind !== 'ollama') return;
  fetchLoading.value = true;
  fetchError.value = null;
  try {
    // Merge the current form drafts into the payload so the preview
    // reflects the in-flight edits (baseUrl, apiKey, models)
    // rather than the record's persisted config.
    const config = draft.value.kind === 'custom'
      ? { ...buildCustomConfigCore(customDraft.value), models: customDraft.value.models }
      : buildOllamaConfig();
    const previewRecord = { ...toRecordEnvelope(draft.value), config };
    const { data, error } = await callApi<ListModelsResult>(
      () => api.api.upstreams['list-models'].$post({ json: { record: previewRecord } }),
    );
    // The toggle may have been turned off while this request was in flight;
    // with fetch disabled the auto block is hidden and dropped on save, so
    // discard the late result rather than repopulating stale auto rows.
    if (draft.value.kind === 'custom' && !customDraft.value.modelsFetch.enabled) return;
    if (error) { fetchError.value = error.message; return; }
    if (draft.value.kind === 'custom') {
      fetchedRaw.value = data.data as CustomRawModel[];
    } else {
      fetchedOllamaModels.value = data.data as UpstreamModelConfig[];
    }
    fetchedCount.value = data.data.length;
    fetchedAtMs.value = Date.now();
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

// True when the current draft config carries enough credentials for the
// list-models call to succeed. Guards mount-time prime and the refresh
// button so a blueprint (empty config) never fires an unauthenticated
// upstream hit. Wizard-emitted patches do NOT auto-fetch here — the
// per-provider "Save and load models" CTA is the create-state path
// (see the note on applyPatch below for why).
const hasCredentialForFetch = computed<boolean>(() => {
  const d = draft.value;
  if (d.kind === 'copilot') return d.config.githubToken !== '';
  if (d.kind === 'codex' || d.kind === 'claude-code') return d.config.accounts.length > 0;
  if (d.kind === 'custom') return d.config.baseUrl !== '' && d.config.apiKey !== '';
  if (d.kind === 'ollama') return d.config.baseUrl !== '';
  return false;
});

// Fetch the live model catalog for the current draft. Skipped for Azure
// (operator-edited catalog, no upstream `/models` endpoint) and when the
// draft has no credential yet (blueprint state). For custom the server
// returns raw rows the dashboard translates through the draft's endpoints,
// so route them into `fetchedRaw` — the same slot the unsaved draft
// preview uses; every other kind receives already-projected
// UpstreamModelConfig rows and lands in `upstreamModels`. Surfaces the
// error on `upstreamModelsError` otherwise. Returns nothing — callers
// wrap this with their own bookkeeping (mount-time prime, operator-driven
// refresh).
const fetchUpstreamModels = async () => {
  if (draft.value.kind === 'azure') return;
  if (!hasCredentialForFetch.value) return;
  upstreamModelsError.value = null;
  const { data, error } = await callApi<ListModelsResult>(
    () => api.api.upstreams['list-models'].$post({ json: { record: toRecordEnvelope(draft.value) } }),
  );
  if (error) { upstreamModelsError.value = error.message; return; }
  if (draft.value.kind === 'custom') {
    fetchedRaw.value = data.data as CustomRawModel[];
  } else {
    upstreamModels.value = data.data as UpstreamModelConfig[];
  }
};

const refreshing = ref(false);
const refreshCachedModels = async () => {
  refreshing.value = true;
  try {
    await fetchUpstreamModels();
    if (upstreamModelsError.value) return;
    // The server-side list-models refreshed the SWR cache too; reload the
    // store so the header's `modelsCache` summary reflects the freshest
    // fetchedAt / lastError the gateway just wrote.
    await upstreamsStore.load();
    const refreshed = upstreamsStore.upstreams.value?.find(u => u.id === draft.value.id);
    if (refreshed) draft.value = { ...draft.value, modelsCache: refreshed.modelsCache };
  } finally {
    refreshing.value = false;
  }
};

// Prime on mount so ModelsPanel renders populated; refresh button reruns
// the same call plus the store reload above.
void fetchUpstreamModels();

const saving = ref(false);
const saveError = ref<string | null>(null);
const modelsPanelInvalid = ref(false);

const buildCustomConfig = () => {
  const config: Record<string, unknown> = {
    ...buildCustomConfigCore(customDraft.value),
    models: customDraft.value.models,
  };
  const overrides: Record<string, string> = {};
  for (const [k, v] of Object.entries(customDraft.value.pathOverrides)) {
    const trimmed = v.trim();
    if (trimmed) overrides[k] = trimmed;
  }
  if (Object.keys(overrides).length > 0) config.pathOverrides = overrides;
  else if (!isCreate.value) config.pathOverrides = null;
  return config;
};

const buildAzureConfig = () => {
  const config: Record<string, unknown> = {
    endpoint: azureDraft.value.endpoint.trim(),
    models: azureDraft.value.models,
  };
  if (azureDraft.value.apiKey.trim()) config.apiKey = azureDraft.value.apiKey.trim();
  return config;
};

const buildOllamaConfig = () => {
  const config: Record<string, unknown> = {
    baseUrl: ollamaDraft.value.baseUrl.trim(),
    models: ollamaDraft.value.models,
  };
  if (ollamaDraft.value.apiKey.trim()) config.apiKey = ollamaDraft.value.apiKey.trim();
  return config;
};

// Editable providers (custom/azure/ollama) rebuild the config from the
// per-provider form draft; OAuth providers hand back the credential slice
// their wizards populated in draft.config / draft.state. In edit state the
// PATCH endpoint only replaces user-owned fields, so the OAuth slice we
// pass here is ignored server-side — it's still safe to include.
const buildConfigForSave = (): unknown => {
  if (draft.value.kind === 'custom') return buildCustomConfig();
  if (draft.value.kind === 'azure') return buildAzureConfig();
  if (draft.value.kind === 'ollama') return buildOllamaConfig();
  return draft.value.config;
};

const save = async ({ openEdit = false }: { openEdit?: boolean } = {}) => {
  saveError.value = null;
  const trimmedName = draft.value.name.trim();
  if (!trimmedName) { saveError.value = 'Name is required'; return; }
  if (modelPrefixInvalid.value) { saveError.value = 'Model name prefix is invalid'; return; }
  if (colorInvalid.value) { saveError.value = 'Color hex is invalid'; return; }
  if (modelsPanelInvalid.value) { saveError.value = 'One or more models have invalid configuration — review each model\'s highlighted fields and validation errors'; return; }
  // OAuth providers can only persist an initial record once the wizard has
  // populated the credential slice; without it the backend's per-kind
  // asserter rejects the POST with an opaque error. Fail early so the
  // dashboard surfaces the user-friendly variant.
  if (isCreate.value) {
    if (draft.value.kind === 'copilot' && !draft.value.config.githubToken) {
      saveError.value = 'Complete the GitHub device flow before saving.';
      return;
    }
    if ((draft.value.kind === 'codex' || draft.value.kind === 'claude-code') && draft.value.config.accounts.length === 0) {
      saveError.value = 'Import a credential before saving.';
      return;
    }
  }

  saving.value = true;
  try {
    const config = buildConfigForSave();
    // sort_order arrives as `0` from the blueprint (a placeholder); resolve
    // to the true next slot at save time so we don't rank the new row at
    // the top of the list.
    const sortOrder = isCreate.value
      ? (upstreamsStore.upstreams.value ?? []).reduce((acc, u) => Math.max(acc, u.sort_order), -1) + 1
      : draft.value.sort_order;
    const baseBody = {
      name: trimmedName,
      enabled: draft.value.enabled,
      sort_order: sortOrder,
      flag_overrides: draft.value.flag_overrides,
      disabled_public_model_ids: draft.value.disabled_public_model_ids,
      proxy_fallback_list: draft.value.proxy_fallback_list,
      model_prefix: draft.value.model_prefix,
      color: draft.value.color,
    };

    if (isCreate.value) {
      // Create carries the full initial record — including the OAuth-
      // populated `state` for copilot / codex / claude-code. The kind
      // discriminator lets the schema route to the per-kind branch.
      const createBody = {
        ...baseBody,
        kind: draft.value.kind,
        config,
        ...(draft.value.kind === 'copilot' || draft.value.kind === 'codex' || draft.value.kind === 'claude-code'
          ? { state: draft.value.state }
          : {}),
      };
      // The kind discriminator collapses to a valid createBody variant at
      // runtime; the RPC client's generic $post accepts unknown JSON.
      const { data, error } = await callApi<UpstreamRecord>(() => api.api.upstreams.$post({ json: createBody as never }));
      if (error) { saveError.value = error.message; return; }
      emit('saved', data);
      // The main Save button bounces back to the list — the operator opened
      // this page to bring a row into existence, not to keep tweaking it. The
      // per-provider "Save and load models" CTA sets openEdit so the newly-
      // saved row's edit page renders next, letting its mount-time list-models
      // populate the catalog for a review pass before the operator leaves.
      await router.replace(openEdit ? `/dashboard/upstreams/${data.id}` : '/dashboard/settings');
    } else {
      // PATCH only user-owned fields. For OAuth providers the backend
      // rejects a `config` patch, so we skip config for them — their
      // credential slice is server-owned and rotates through the action
      // endpoints, not through the save button.
      const patchBody: Record<string, unknown> = { ...baseBody };
      if (draft.value.kind === 'custom' || draft.value.kind === 'azure' || draft.value.kind === 'ollama') {
        patchBody.config = config;
      }
      const { data, error } = await callApi<UpstreamRecord>(() => api.api.upstreams[':id'].$patch({ param: { id: draft.value.id }, json: patchBody as never }));
      if (error) { saveError.value = error.message; return; }
      emit('saved', data);
      // Re-seed the draft from the fresh server response so the editor
      // reflects whatever the server merged (e.g. modelsCache, normalized
      // proxy list) and the api-key form slot clears back to "leave blank
      // to keep".
      draft.value = structuredClone(data);
      seedProviderDrafts();
    }
  } finally {
    saving.value = false;
  }
};

const cancel = async () => {
  await router.push('/dashboard/settings');
};

// Wizards emit patches into the draft. `state` is the OAuth-owned slice
// (accounts + credentials); `config` is the identity slice. Shallow-merge
// per key so a patch that only carries `state` doesn't blow away `config`.
// Auto-fetching upstream models on a create-state patch is not viable:
// provider factories read row state from DB by upstream id, and the
// synthetic 'draft' id used for list-models has no DB row. The
// per-provider "Save and load models" CTA is the create-state path — it
// saves first, then the edit page's mount-time prime populates the
// catalog.
const applyPatch = (patch: { config?: unknown; state?: unknown }) => {
  const next: UpstreamRecord = { ...draft.value };
  if (patch.config !== undefined) (next as { config: unknown }).config = patch.config;
  if (patch.state !== undefined) (next as { state: unknown }).state = patch.state;
  draft.value = next;
};

const onError = (message: string) => {
  saveError.value = message;
};

// Read-only providers never invoke the v-model setter; the getter returns [] to satisfy the type contract.
const modelsManualForActive = computed<UpstreamModelConfig[]>({
  get: () => {
    if (draft.value.kind === 'custom') return customDraft.value.models;
    if (draft.value.kind === 'azure') return azureDraft.value.models;
    if (draft.value.kind === 'ollama') return ollamaDraft.value.models;
    return [];
  },
  set: next => {
    if (draft.value.kind === 'custom') customDraft.value = { ...customDraft.value, models: next };
    else if (draft.value.kind === 'azure') azureDraft.value = { ...azureDraft.value, models: next };
    else if (draft.value.kind === 'ollama') ollamaDraft.value = { ...ollamaDraft.value, models: next };
  },
});

// Auto rows are the live catalog the upstream itself decides. Saved rows
// resolve through the SWR cache via `upstreamModels`; unsaved custom /
// ollama drafts fall back to the inline list-models preview.
const autoForActive = computed<UpstreamModelConfig[]>(() => {
  if (draft.value.kind === 'custom') {
    if (!customDraft.value.modelsFetch.enabled) return [];
    // Both saved and unsaved custom rows read the raw catalog from
    // `fetchedRaw` and translate through the draft's endpoints — the
    // server returns raw upstream rows uniformly for both call paths.
    return customAutoModelsFromDraft.value;
  }
  if (draft.value.kind === 'ollama') {
    if (!isCreate.value) return upstreamModels.value;
    return fetchedOllamaModels.value;
  }
  return upstreamModels.value;
});

const upstreamIdLabelForActive = computed(() => draft.value.kind === 'azure' ? 'Deployment' : 'Upstream Model ID');

const showCacheStatus = computed(() => !isCreate.value && draft.value.kind !== 'azure');

// Public-id catalogue feeding the disabled-models combobox: every model
// currently surfaced for this provider, deduped by public id. A model's
// public id is its publicModelId override when set, otherwise its
// upstreamModelId — same rule the data plane filters by.
const availableModelItems = computed<{ value: string; label: string }[]>(() => {
  const seen = new Set<string>();
  const items: { value: string; label: string }[] = [];
  const collect = (list: readonly UpstreamModelConfig[]) => {
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
        <span v-if="isCreate" class="font-semibold text-white">New upstream</span>
        <span v-else class="font-semibold text-white">{{ draft.name || 'Upstream' }}</span>
      </nav>
      <div class="ml-auto flex items-center gap-2">
        <Button variant="secondary" :disabled="saving" @click="cancel">Cancel</Button>
        <Button :loading="saving" @click="() => save()">Save changes</Button>
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
        :draft="draft"
        v-model:name="name"
        v-model:enabled="enabled"
        v-model:flag-overrides="flagOverrides"
        v-model:disabled-ids="disabledPublicModelIds"
        v-model:proxy-fallback-list="proxyFallbackList"
        v-model:model-prefix="modelPrefix"
        @update:model-prefix-invalid="v => modelPrefixInvalid = v"
        v-model:color="color"
        @update:color-invalid="v => colorInvalid = v"
        v-model:custom="customDraft"
        v-model:azure="azureDraft"
        v-model:ollama="ollamaDraft"
        :flags="flags"
        :colo-aware="coloAware"
        :current-colo="currentColo"
        :custom-api-key-set="!!(draft.kind === 'custom' && draft.config.apiKey)"
        :azure-api-key-set="!!(draft.kind === 'azure' && draft.config.apiKey)"
        :ollama-api-key-set="!!(draft.kind === 'ollama' && draft.config.apiKey)"
        :fetch-loading="fetchLoading"
        :fetch-error="fetchError"
        :fetch-status="fetchStatus"
        :available-model-items="availableModelItems"
        :models-cache="showCacheStatus ? draft.modelsCache : null"
        :refreshing="refreshing"
        :saving="saving"
        @fetch-models="listDraftModels"
        @refresh-cache="refreshCachedModels"
        @patched="applyPatch"
        @save-and-open-edit="save({ openEdit: true })"
        @error="onError"
      />
      <ModelsPanel
        ref="modelsPanelRef"
        v-model="modelsManualForActive"
        v-model:disabled-ids="disabledPublicModelIds"
        :auto-models="autoForActive"
        :flags="flags"
        :upstream-flag-overrides="flagOverrides"
        :provider-flag-defaults="draft.flag_defaults"
        :upstream-id-label="upstreamIdLabelForActive"
        :read-only="draft.kind === 'copilot' || draft.kind === 'codex' || draft.kind === 'claude-code'"
        :all-manual="draft.kind === 'azure'"
        @update:invalid="v => modelsPanelInvalid = v"
      />
    </div>
  </div>
</template>
