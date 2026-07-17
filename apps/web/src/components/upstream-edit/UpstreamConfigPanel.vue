<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue';

import AzureConfigPanel from './AzureConfigPanel.vue';
import ClaudeCodeConfigPanel from './ClaudeCodeConfigPanel.vue';
import CodexConfigPanel from './CodexConfigPanel.vue';
import CopilotConfigPanel from './CopilotConfigPanel.vue';
import type { AzureDraft, CustomDraft, OllamaDraft } from './customConfig.ts';
import CustomConfigPanel from './CustomConfigPanel.vue';
import FlagOverridesEditor from './FlagOverridesEditor.vue';
import ModelPrefixEditor from './ModelPrefixEditor.vue';
import ModelsCacheStatus from './ModelsCacheStatus.vue';
import OllamaConfigPanel from './OllamaConfigPanel.vue';
import ProxyFallbackListPanel from './ProxyFallbackListPanel.vue';
import type { ModelPrefixConfig, ProxyFallbackEntry, UpstreamColor, UpstreamRecord } from '../../api/types.ts';
import ColorPicker from '../upstreams/ColorPicker.vue';
import { providerMeta } from '../upstreams/provider-meta.ts';
import UpstreamBadge from '../upstreams/UpstreamBadge.vue';
import type { Flag, FlagOverrides } from '@floway-dev/provider/flags';
import { Input, Switch, TagCombobox } from '@floway-dev/ui';

const name = defineModel<string>('name', { required: true });
const enabled = defineModel<boolean>('enabled', { required: true });
const flagOverrides = defineModel<FlagOverrides>('flagOverrides', { required: true });
const disabledIds = defineModel<string[]>('disabledIds', { required: true });
const customDraft = defineModel<CustomDraft>('custom', { required: true });
const azureDraft = defineModel<AzureDraft>('azure', { required: true });
const ollamaDraft = defineModel<OllamaDraft>('ollama', { required: true });
const proxyFallbackList = defineModel<ProxyFallbackEntry[]>('proxyFallbackList', { required: true });
const modelPrefix = defineModel<ModelPrefixConfig | null>('modelPrefix', { required: true });
const color = defineModel<UpstreamColor | null>('color', { required: true });

// `draft` is the parent's single source of truth; wizards emit patches
// through `patched` for the parent to merge.
const props = defineProps<{
  draft: UpstreamRecord;
  flags: Flag[];
  customApiKeySet: boolean;
  azureApiKeySet: boolean;
  ollamaApiKeySet: boolean;
  fetchLoading: boolean;
  fetchError: string | null;
  fetchStatus: string | null;
  availableModelItems: { value: string; label: string }[];
  // Live cache snapshot for the saved upstream. Null in create mode and for
  // Azure (which has no fetch step) — `ModelsCacheStatus` is rendered only
  // when this is provided. The panel is informational only; the "Fetch"
  // button in the per-provider config panel is the sole re-fetch entry.
  modelsCache: UpstreamRecord['modelsCache'] | null;
  saving: boolean;
  coloAware: boolean;
  currentColo: string | null;
}>();

defineEmits<{
  'fetch-models': [];
  patched: [patch: { config?: unknown; state?: unknown }];
  'save-and-open-edit': [];
  error: [message: string];
  'update:model-prefix-invalid': [invalid: boolean];
  'update:color-invalid': [invalid: boolean];
}>();

const kind = computed(() => props.draft.kind);
const isCreate = computed(() => props.draft.id === '');

// Intrinsic floor for the aside: smallest height at which every
// non-flag-editor section is fully laid out AND the flag editor still has
// its declared min-h-[16rem]. Drives `min-h` on the aside so the rail
// grows past its (right-pane-driven) max-h cap when the rest of the form
// would otherwise overflow.
const FLAG_SECTION_MIN_PX = 16 * 16;
const contentRef = useTemplateRef<HTMLElement>('contentRef');
const flagSectionRef = useTemplateRef<HTMLElement>('flagSectionRef');
const headerRef = useTemplateRef<HTMLElement>('headerRef');
const intrinsicFloorPx = ref(0);
let floorObserver: ResizeObserver | undefined;
const measureFloor = () => {
  const content = contentRef.value;
  const flag = flagSectionRef.value;
  const header = headerRef.value;
  if (!content) return;
  const cs = getComputedStyle(content);
  const padTop = parseFloat(cs.paddingTop);
  const padBottom = parseFloat(cs.paddingBottom);
  const gap = parseFloat(cs.rowGap);
  const children = Array.from(content.children) as HTMLElement[];
  let h = padTop + padBottom;
  if (children.length > 1) h += gap * (children.length - 1);
  for (const child of children) {
    h += child === flag ? FLAG_SECTION_MIN_PX : child.scrollHeight;
  }
  if (header) h += header.getBoundingClientRect().height;
  intrinsicFloorPx.value = h;
};
watch([contentRef, flagSectionRef, headerRef, kind], () => {
  floorObserver?.disconnect();
  const content = contentRef.value;
  if (!content) return;
  floorObserver = new ResizeObserver(measureFloor);
  for (const child of Array.from(content.children) as HTMLElement[]) {
    floorObserver.observe(child);
  }
  if (headerRef.value) floorObserver.observe(headerRef.value);
  measureFloor();
}, { immediate: true, flush: 'post' });
onBeforeUnmount(() => floorObserver?.disconnect());
</script>

<template>
  <aside
    class="glass-card flex min-w-0 flex-col lg:max-h-[max(calc(100vh-7rem),var(--right-pane-h,0px))]"
    :style="{ minHeight: `${Math.ceil(intrinsicFloorPx)}px` }"
  >
    <header ref="headerRef" class="flex shrink-0 items-center gap-3 border-b border-white/[0.06] px-5 py-4">
      <UpstreamBadge
        :kind="kind"
        :color="color"
        variant="badge"
        size="sm"
        class="!rounded !uppercase tracking-wider !text-[10px] !font-semibold"
      >{{ providerMeta(kind).label }}</UpstreamBadge>
      <h2 class="min-w-0 truncate text-sm font-semibold text-white">
        {{ name || (isCreate ? 'New upstream' : 'Upstream') }}
      </h2>
      <Switch v-model="enabled" class="ml-auto" />
    </header>

    <div ref="contentRef" class="flex min-h-0 flex-1 flex-col gap-6 px-5 py-5">

      <section class="shrink-0">
        <label class="mb-1.5 block text-xs font-medium text-gray-500">Name</label>
        <Input v-model="name" placeholder="e.g. OpenAI Production" />
      </section>

      <section class="shrink-0">
        <label class="mb-1.5 block text-xs font-medium text-gray-500">Color</label>
        <ColorPicker v-model="color" :kind="kind" @update:invalid="v => $emit('update:color-invalid', v)" />
      </section>

      <!-- Proxy chain sits at the top so the operator decides on egress
           BEFORE the per-provider section runs anything that depends on
           it — the copilot device flow, codex/claude-code OAuth token
           exchange, and the custom/azure/ollama model probes all dial
           through this list. Above the fold the panel doubles as a
           confirmation that a proxy is already configured. -->
      <ProxyFallbackListPanel
        v-model="proxyFallbackList"
        :upstream-id="isCreate ? null : draft.id"
        :colo-aware="coloAware"
        :current-colo="currentColo"
        class="shrink-0"
      />

      <section v-if="draft.kind === 'custom'" class="shrink-0">
        <CustomConfigPanel
          v-model="customDraft"
          :api-key-set="customApiKeySet"
          :edit-mode="!isCreate"
          :fetch-loading="fetchLoading"
          :fetch-error="fetchError"
          :fetch-status="fetchStatus"
          @fetch-models="$emit('fetch-models')"
        >
          <template v-if="modelsCache" #cache-status>
            <ModelsCacheStatus :models-cache="modelsCache" />
          </template>
        </CustomConfigPanel>
      </section>

      <section v-else-if="draft.kind === 'azure'" class="shrink-0">
        <AzureConfigPanel
          v-model="azureDraft"
          :api-key-set="azureApiKeySet"
          :edit-mode="!isCreate"
        />
      </section>

      <section v-else-if="draft.kind === 'ollama'" class="shrink-0">
        <OllamaConfigPanel
          v-model="ollamaDraft"
          :api-key-set="ollamaApiKeySet"
          :edit-mode="!isCreate"
          :fetch-loading="fetchLoading"
          :fetch-error="fetchError"
          :fetch-status="fetchStatus"
          @fetch-models="$emit('fetch-models')"
        >
          <template v-if="modelsCache" #cache-status>
            <ModelsCacheStatus :models-cache="modelsCache" />
          </template>
        </OllamaConfigPanel>
      </section>

      <section v-else-if="draft.kind === 'copilot'" class="shrink-0">
        <CopilotConfigPanel
          :draft="draft"
          :saving="saving"
          @patched="p => $emit('patched', p)"
          @save-and-open-edit="$emit('save-and-open-edit')"
        />
      </section>

      <section v-else-if="draft.kind === 'codex'" class="shrink-0">
        <CodexConfigPanel
          :draft="draft"
          :saving="saving"
          @patched="p => $emit('patched', p)"
          @save-and-open-edit="$emit('save-and-open-edit')"
          @error="m => $emit('error', m)"
        />
      </section>

      <section v-else-if="draft.kind === 'claude-code'" class="shrink-0">
        <ClaudeCodeConfigPanel
          :draft="draft"
          :saving="saving"
          @patched="p => $emit('patched', p)"
          @save-and-open-edit="$emit('save-and-open-edit')"
          @error="m => $emit('error', m)"
        />
      </section>

      <!-- Cache snapshot for OAuth-driven providers (Copilot / Codex / Claude
           Code) — they have no in-panel Fetch button, so the snapshot sits at
           the top level right under the provider panel. Custom / Ollama inject
           theirs into the provider panel's `#cache-status` slot instead, so the
           snapshot sits directly under the Fetch button. Null in create mode
           and for Azure (no fetch step). -->
      <section v-if="modelsCache && draft.kind !== 'custom' && draft.kind !== 'ollama'" class="shrink-0">
        <p class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Models Cache</p>
        <ModelsCacheStatus :models-cache="modelsCache" />
      </section>

      <section class="shrink-0">
        <ModelPrefixEditor v-model="modelPrefix" @update:invalid="v => $emit('update:model-prefix-invalid', v)" />
      </section>

      <section class="shrink-0">
        <p class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          Disabled Models <span class="text-accent-cyan">({{ disabledIds.length }})</span>
        </p>
        <TagCombobox
          v-model="disabledIds"
          :items="availableModelItems"
          placeholder="Search models, or type an id to disable"
          empty-text="Type a model id and press Enter to disable it"
        />
        <p class="mt-1.5 text-[11px] text-gray-600">
          Disabled models are hidden from the catalog and cannot be routed to. Toggle a model card on the right, or remove an entry here.
        </p>
      </section>

      <!-- Feature-flag editor fills the remaining column height (so the rail
           always reaches the same bottom as the right pane), but never
           shrinks below 16rem — when the right pane is short, the flag list
           scrolls inside this minimum-height area instead of disappearing. -->
      <section ref="flagSectionRef" class="flex min-h-[16rem] flex-1 flex-col gap-2">
        <p class="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          Upstream Feature Flags <span class="text-accent-cyan">({{ Object.keys(flagOverrides).length }})</span>
        </p>
        <FlagOverridesEditor
          v-model="flagOverrides"
          :flags="flags"
          :provider-defaults="draft.flag_defaults"
          name-prefix="upstream-flag"
          class="min-h-0 flex-1"
        />
      </section>

    </div>
  </aside>
</template>
