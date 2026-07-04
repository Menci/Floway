<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue';

import AzureConfigPanel from './AzureConfigPanel.vue';
import ClaudeCodeConfigPanel from './ClaudeCodeConfigPanel.vue';
import CodexConfigPanel from './CodexConfigPanel.vue';
import CopilotConfigPanel from './CopilotConfigPanel.vue';
import CursorConfigPanel from './CursorConfigPanel.vue';
import type { AzureDraft, CustomDraft, OllamaDraft } from './customConfig.ts';
import CustomConfigPanel from './CustomConfigPanel.vue';
import FlagOverridesEditor from './FlagOverridesEditor.vue';
import ModelPrefixEditor from './ModelPrefixEditor.vue';
import ModelsCacheStatus from './ModelsCacheStatus.vue';
import OllamaConfigPanel from './OllamaConfigPanel.vue';
import ProxyFallbackListPanel from './ProxyFallbackListPanel.vue';
import type { CopilotQuotaSnapshot, CursorDashboardUsage, FlagDef, ModelPrefixConfig, ProxyFallbackEntry, UpstreamProviderKind, UpstreamRecord } from '../../api/types.ts';
import { providerBadgeClass, providerMeta } from '../upstreams/provider-meta.ts';
import { Input, Switch, TagCombobox } from '@floway-dev/ui';

const name = defineModel<string>('name', { required: true });
const enabled = defineModel<boolean>('enabled', { required: true });
const flagOverrides = defineModel<Record<string, boolean>>('flagOverrides', { required: true });
const disabledIds = defineModel<string[]>('disabledIds', { required: true });
const customDraft = defineModel<CustomDraft>('custom', { required: true });
const azureDraft = defineModel<AzureDraft>('azure', { required: true });
const ollamaDraft = defineModel<OllamaDraft>('ollama', { required: true });
const cursorPrivacyMode = defineModel<boolean>('cursorPrivacyMode', { required: true });
const proxyFallbackList = defineModel<ProxyFallbackEntry[]>('proxyFallbackList', { required: true });
const modelPrefix = defineModel<ModelPrefixConfig | null>('modelPrefix', { required: true });

type CommonConfigPanelProps = {
  kind: UpstreamProviderKind;
  flags: FlagDef[];
  customApiKeySet: boolean;
  azureApiKeySet: boolean;
  ollamaApiKeySet: boolean;
  fetchLoading: boolean;
  fetchError: string | null;
  fetchStatus: string | null;
  availableModelItems: { value: string; label: string }[];
  initialCopilotQuota?: CopilotQuotaSnapshot | null;
  initialCopilotQuotaError?: string | null;
  initialCursorQuota?: CursorDashboardUsage | null;
  initialCursorQuotaError?: string | null;
  // Live cache snapshot for the saved upstream. Null in create mode and for
  // Azure (which has no fetch step) — `ModelsCacheStatus` is rendered only
  // when this is provided.
  modelsCache: UpstreamRecord['modelsCache'] | null;
  refreshing: boolean;
  coloAware: boolean;
  currentColo: string | null;
};

const props = defineProps<
  | (CommonConfigPanelProps & { mode: 'create'; record: null })
  | (CommonConfigPanelProps & { mode: 'edit'; record: UpstreamRecord })
>();

defineEmits<{
  'fetch-models': [];
  'refresh-cache': [];
  imported: [record: UpstreamRecord];
  error: [message: string];
  'claude-code-quota-refreshed': [upstream: UpstreamRecord];
  'update:model-prefix-invalid': [invalid: boolean];
}>();

// Per-provider narrowed views of (mode, record) so each child panel receives
// the matching discriminated variant without inline casts. Edit mode and a
// record-of-the-wrong-kind both yield null — the per-provider section is
// already gated on `kind === '<kind>'` in the template, so this only
// happens during the brief window when a sibling section is mounting.
type CodexRecord = Extract<UpstreamRecord, { kind: 'codex' }>;
type ClaudeCodeRecord = Extract<UpstreamRecord, { kind: 'claude-code' }>;
type CopilotRecord = Extract<UpstreamRecord, { kind: 'copilot' }>;
type CursorRecord = Extract<UpstreamRecord, { kind: 'cursor' }>;
type PanelMode<R> = { mode: 'create'; record: null } | { mode: 'edit'; record: R };

const codexPanel = computed<PanelMode<CodexRecord> | null>(() => {
  if (props.mode === 'create') return { mode: 'create', record: null };
  return props.record.kind === 'codex' ? { mode: 'edit', record: props.record } : null;
});
const claudeCodePanel = computed<PanelMode<ClaudeCodeRecord> | null>(() => {
  if (props.mode === 'create') return { mode: 'create', record: null };
  return props.record.kind === 'claude-code' ? { mode: 'edit', record: props.record } : null;
});
const copilotPanel = computed<PanelMode<CopilotRecord> | null>(() => {
  if (props.mode === 'create') return { mode: 'create', record: null };
  return props.record.kind === 'copilot' ? { mode: 'edit', record: props.record } : null;
});
const cursorPanel = computed<PanelMode<CursorRecord> | null>(() => {
  if (props.mode === 'create') return { mode: 'create', record: null };
  return props.record.kind === 'cursor' ? { mode: 'edit', record: props.record } : null;
});

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
watch([contentRef, flagSectionRef, headerRef, () => props.kind], () => {
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
      <span
        class="rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
        :class="providerBadgeClass(kind)"
      >{{ providerMeta(kind).label }}</span>
      <h2 class="min-w-0 truncate text-sm font-semibold text-white">
        {{ name || (mode === 'create' ? 'New upstream' : 'Upstream') }}
      </h2>
      <Switch v-model="enabled" class="ml-auto" />
    </header>

    <div ref="contentRef" class="flex min-h-0 flex-1 flex-col gap-6 px-5 py-5">

      <section v-if="!(mode === 'create' && (kind === 'copilot' || kind === 'codex' || kind === 'claude-code' || kind === 'cursor'))" class="shrink-0">
        <label class="mb-1.5 block text-xs font-medium text-gray-500">Name</label>
        <Input v-model="name" placeholder="e.g. OpenAI Production" />
      </section>

      <!-- Proxy chain sits at the top so the operator decides on egress
           BEFORE the per-provider section runs anything that depends on
           it — the copilot device flow, codex/claude-code OAuth token
           exchange, and the custom/azure/ollama model probes all dial
           through this list. Above the fold the panel doubles as a
           confirmation that a proxy is already configured. -->
      <ProxyFallbackListPanel
        v-model="proxyFallbackList"
        :upstream-id="record?.id ?? null"
        :colo-aware="coloAware"
        :current-colo="currentColo"
        class="shrink-0"
      />

      <section v-if="kind === 'custom'" class="shrink-0">
        <CustomConfigPanel
          v-model="customDraft"
          :api-key-set="customApiKeySet"
          :edit-mode="mode === 'edit'"
          :fetch-loading="fetchLoading"
          :fetch-error="fetchError"
          :fetch-status="fetchStatus"
          @fetch-models="$emit('fetch-models')"
        />
      </section>

      <section v-else-if="kind === 'azure'" class="shrink-0">
        <AzureConfigPanel
          v-model="azureDraft"
          :api-key-set="azureApiKeySet"
          :edit-mode="mode === 'edit'"
        />
      </section>

      <section v-else-if="kind === 'ollama'" class="shrink-0">
        <OllamaConfigPanel
          v-model="ollamaDraft"
          :api-key-set="ollamaApiKeySet"
          :edit-mode="mode === 'edit'"
          :fetch-loading="fetchLoading"
          :fetch-error="fetchError"
          :fetch-status="fetchStatus"
          @fetch-models="$emit('fetch-models')"
        />
      </section>

      <section v-else-if="kind === 'copilot' && copilotPanel" class="shrink-0">
        <CopilotConfigPanel
          v-bind="copilotPanel"
          :initial-quota="initialCopilotQuota"
          :initial-quota-error="initialCopilotQuotaError"
          :proxy-fallback-list="proxyFallbackList"
          @completed="u => u && $emit('imported', u)"
        />
      </section>

      <section v-else-if="kind === 'codex' && codexPanel" class="shrink-0">
        <CodexConfigPanel
          v-bind="codexPanel"
          :proxy-fallback-list="proxyFallbackList"
          @imported="u => $emit('imported', u)"
          @error="m => $emit('error', m)"
        />
      </section>

      <section v-else-if="kind === 'claude-code' && claudeCodePanel" class="shrink-0">
        <ClaudeCodeConfigPanel
          v-bind="claudeCodePanel"
          :proxy-fallback-list="proxyFallbackList"
          @imported="u => $emit('imported', u)"
          @quota-refreshed="u => $emit('claude-code-quota-refreshed', u)"
          @error="m => $emit('error', m)"
        />
      </section>

      <section v-else-if="kind === 'cursor' && cursorPanel" class="shrink-0">
        <CursorConfigPanel
          v-bind="cursorPanel"
          v-model:privacy-mode="cursorPrivacyMode"
          :proxy-fallback-list="proxyFallbackList"
          :initial-quota="initialCursorQuota"
          :initial-quota-error="initialCursorQuotaError"
          @imported="u => $emit('imported', u)"
          @error="m => $emit('error', m)"
        />
      </section>

      <section class="shrink-0">
        <ModelPrefixEditor v-model="modelPrefix" @update:invalid="v => $emit('update:model-prefix-invalid', v)" />
      </section>

      <section v-if="modelsCache" class="shrink-0">
        <p class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Models Cache</p>
        <ModelsCacheStatus
          :models-cache="modelsCache"
          :refreshing="refreshing"
          @refresh="$emit('refresh-cache')"
        />
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
          :kind="kind"
          name-prefix="upstream-flag"
          class="min-h-0 flex-1"
        />
      </section>

    </div>
  </aside>
</template>
