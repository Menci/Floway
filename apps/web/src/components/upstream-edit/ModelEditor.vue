<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import EndpointsField from './EndpointsField.vue';
import FlagOverridesEditor from './FlagOverridesEditor.vue';
import { defaultEndpointsForKind, publicIdOf, titleFor, type Row } from './modelRows.ts';
import PricingEditor from './PricingEditor.vue';
import RerankTargetEditor from './RerankTargetEditor.vue';
import type { AnnouncedMetadata, ModelKind, UpstreamModelConfig } from '../../api/types.ts';
import ChatMetadataEditor from '../shared/ChatMetadataEditor.vue';
import type { Flag, FlagDefaults, FlagOverrides } from '@floway-dev/provider/flags';
import { Button, Input, Select, Switch } from '@floway-dev/ui';

const props = defineProps<{
  row: Row | null;
  flags: Flag[];
  upstreamFlagOverrides: FlagOverrides;
  providerFlagDefaults: FlagDefaults;
  // "Upstream Model ID" for custom/copilot, "Deployment" for azure.
  upstreamIdLabel: string;
  // True when this manual row's upstream id is fixed (seeded from an auto
  // twin) — the field renders read-only so the row keeps shadowing the twin.
  isUpstreamIdLocked: boolean;
  // Controls visibility of the "Switch to Auto / Manual" toggle in the header.
  hasAutoCounterpart: boolean;
  modeSwitchable: boolean;
  allowRerank: boolean;
}>();

const emit = defineEmits<{
  'patch-config': [patch: Partial<UpstreamModelConfig>];
  'set-mode': [next: 'auto' | 'manual'];
  remove: [];
}>();

const kindOptions = computed<{ value: ModelKind; label: string }[]>(() => [
  { value: 'chat', label: 'Chat' },
  { value: 'embedding', label: 'Embedding' },
  { value: 'image', label: 'Image' },
  ...(props.allowRerank ? [{ value: 'rerank' as const, label: 'Rerank' }] : []),
]);

const config = computed<UpstreamModelConfig | null>(() => props.row?.config ?? null);
const editable = computed(() => props.row?.kind === 'manual');
const rowKind = computed<ModelKind>(() => config.value?.kind ?? 'chat');
const lastFlagOverrides = ref<FlagOverrides>({});

const patch = (next: Partial<UpstreamModelConfig>) => {
  if (!editable.value) return;
  emit('patch-config', next);
};

const setKind = (k: ModelKind) => {
  if (!editable.value || !config.value) return;
  patch({
    kind: k,
    endpoints: defaultEndpointsForKind(k, config.value.endpoints),
    chat: k === 'chat' ? config.value.chat : undefined,
    rerankTarget: k === 'rerank' ? config.value.rerankTarget ?? { protocol: 'cohere-v2' } : undefined,
  });
};

watch(() => [props.row?.uiId, props.row?.kind] as const, () => {
  lastFlagOverrides.value = {};
});

const toggleFlagOverridesEnabled = () => {
  if (!editable.value || !config.value) return;
  if (config.value.flagOverrides !== undefined) {
    lastFlagOverrides.value = { ...config.value.flagOverrides };
    patch({ flagOverrides: undefined });
  } else {
    patch({ flagOverrides: { ...lastFlagOverrides.value } });
  }
};

// ── Chat metadata ──────────────────────────────────────────────────────────

// Mirror the shared editor's value shape: pull the model's `limits` +
// `chat` block out of the row config, hand it to ChatMetadataEditor,
// and forward edits back through `patch()`.
const chatMetadataValue = computed<AnnouncedMetadata | undefined>(() => {
  if (!config.value) return undefined;
  const out: AnnouncedMetadata = {};
  if (config.value.limits) out.limits = config.value.limits;
  if (config.value.chat) out.chat = config.value.chat;
  return out;
});

const onChatMetadataChange = (next: AnnouncedMetadata | undefined) => {
  patch({ limits: next?.limits, chat: next?.chat });
};

</script>

<template>
  <div class="flex min-h-[28rem] flex-col">
    <div v-if="!row || !config" class="flex flex-1 items-center justify-center p-12 text-center text-sm text-gray-500">
      Select a model on the left to edit its settings.
    </div>

    <template v-else>
      <header class="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-5 py-4">
        <div class="min-w-0">
          <h2 class="truncate text-lg font-semibold text-white">{{ titleFor(row) }}</h2>
          <p class="mt-1 flex items-center gap-2 font-mono text-xs text-gray-500">
            <span class="truncate">{{ publicIdOf(row) || '—' }}</span>
            <span v-if="!editable" class="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-gray-400">Auto</span>
            <span v-else class="rounded border border-accent-cyan/30 bg-accent-cyan/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent-cyan">Manual</span>
          </p>
        </div>
        <div class="ml-auto flex shrink-0 items-center gap-2">
          <Button
            v-if="modeSwitchable && hasAutoCounterpart && !editable"
            variant="secondary"
            size="sm"
            @click="$emit('set-mode', 'manual')"
          >Switch to Manual</Button>
          <Button
            v-else-if="modeSwitchable && hasAutoCounterpart && editable"
            variant="secondary"
            size="sm"
            @click="$emit('set-mode', 'auto')"
          >Switch to Auto</Button>
          <Button
            v-if="editable"
            variant="danger"
            size="sm"
            @click="$emit('remove')"
          >Remove</Button>
        </div>
      </header>

      <div class="space-y-7 px-5 py-6">

        <section>
          <div class="mb-3 flex items-baseline gap-3">
            <h3 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Identity</h3>
            <span class="text-[11px] text-gray-500">how the model is exposed publicly and what we send upstream</span>
          </div>
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <label class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">Display Name</span>
              <Input
                :model-value="config.display_name"
                :readonly="!editable"
                placeholder="e.g. GPT 5.4 Pro"
                @update:model-value="v => patch({ display_name: v || undefined })"
              />
            </label>
            <label class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">{{ upstreamIdLabel }}</span>
              <Input
                :model-value="config.upstreamModelId"
                :readonly="!editable || isUpstreamIdLocked"
                placeholder="raw upstream id"
                class="font-mono"
                @update:model-value="v => patch({ upstreamModelId: v })"
              />
            </label>
            <label class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">Public Model ID</span>
              <Input
                :model-value="config.publicModelId"
                :readonly="!editable"
                :placeholder="config.upstreamModelId || ''"
                class="font-mono"
                @update:model-value="v => patch({ publicModelId: v || undefined })"
              />
            </label>
            <label class="block space-y-1.5">
              <span class="block text-xs font-medium text-gray-500">Kind</span>
              <Select
                v-if="editable"
                :model-value="rowKind"
                :options="kindOptions"
                @update:model-value="k => setKind(k as ModelKind)"
              />
              <div v-else tabindex="-1" style="pointer-events: none">
                <Select :model-value="rowKind" :options="kindOptions" />
              </div>
            </label>
          </div>
        </section>

        <section v-if="rowKind === 'chat' || rowKind === 'image'">
          <div class="mb-3 flex items-baseline gap-3">
            <h3 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Supported Endpoints</h3>
            <span class="text-[11px] text-gray-500">protocols this model responds to</span>
          </div>
          <EndpointsField
            :model-value="config.endpoints ?? {}"
            :kind="rowKind === 'image' ? 'image' : 'chat'"
            :disabled="!editable"
            @update:model-value="v => patch({ endpoints: v })"
          />
        </section>

        <RerankTargetEditor
          v-if="rowKind === 'rerank' && config.rerankTarget"
          :model-value="config.rerankTarget"
          :disabled="!editable"
          @update:model-value="value => patch({ rerankTarget: value })"
        />

        <ChatMetadataEditor
          v-if="rowKind === 'chat' || rowKind === 'embedding'"
          :model-value="chatMetadataValue"
          :kind="rowKind"
          :mode="editable ? 'manual' : 'auto'"
          @update:model-value="onChatMetadataChange"
        />

        <PricingEditor
          :key="row.uiId + ':' + row.kind"
          :model-value="config.pricing"
          :kind="rowKind"
          :editable="editable"
          @update:model-value="value => patch({ pricing: value })"
        />

        <section>
          <div class="mb-3 flex items-baseline gap-3">
            <h3 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Feature Flags</h3>
            <span v-if="editable" class="text-[11px] text-gray-500">applied on top of upstream-level flags; <code class="font-mono">Inherit</code> reflects the upstream-resolved value</span>
            <Switch
              v-if="editable"
              :model-value="config.flagOverrides !== undefined"
              class="ml-auto"
              @update:model-value="toggleFlagOverridesEnabled"
            />
          </div>
          <FlagOverridesEditor
            v-if="!editable || config.flagOverrides !== undefined"
            :model-value="config.flagOverrides ?? {}"
            :flags="flags"
            :provider-defaults="providerFlagDefaults"
            :inherited-overrides="upstreamFlagOverrides"
            :name-prefix="`${row.uiId}-flag`"
            :read-only="!editable"
            class="max-h-72"
            @update:model-value="v => patch({ flagOverrides: v })"
          />
          <p v-else class="text-[11px] text-gray-600">
            Toggle on to override individual flags for this model only.
          </p>
        </section>

      </div>
    </template>
  </div>
</template>
