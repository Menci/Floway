<script setup lang="ts">
import { computed } from 'vue';

import type { ControlPlaneModel, ModelAlias } from '../../api/types.ts';
import { computeAliasLevelWarnings } from '../alias-edit/warnings.ts';
import { Tooltip } from '@floway-dev/ui';

const props = defineProps<{
  alias: ModelAlias;
  models: readonly ControlPlaneModel[] | null;
}>();

defineEmits<{
  edit: [];
  delete: [];
}>();

const title = computed(() => props.alias.display_name ?? props.alias.name);

const KIND_LABELS: Record<ModelAlias['kind'], string> = {
  chat: 'Chat',
  embedding: 'Embedding',
  image: 'Image',
  rerank: 'Rerank',
};

const SELECTION_LABELS: Record<ModelAlias['selection'], string> = {
  'first-available': 'First available',
  random: 'Random',
};

const kindLabel = computed(() => KIND_LABELS[props.alias.kind]);
const selectionLabel = computed(() => SELECTION_LABELS[props.alias.selection]);
const targetCountLabel = computed(() => `${props.alias.targets.length} target${props.alias.targets.length === 1 ? '' : 's'}`);

const aliasWarnings = computed(() => computeAliasLevelWarnings(props.alias, props.models));
const aliasWarningTooltip = computed(() => aliasWarnings.value.map(w => w.message).join('\n'));
</script>

<template>
  <div class="rounded-lg border border-white/5 bg-surface-800/80 px-3 py-2.5">
    <div class="flex items-center gap-3">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-baseline gap-x-2">
          <h4 class="truncate text-sm font-semibold text-white">{{ title }}</h4>
          <span class="truncate font-mono text-xs text-gray-500">{{ alias.name }}</span>
        </div>
        <p class="mt-0.5 truncate text-xs text-gray-500">
          {{ kindLabel }} · {{ targetCountLabel }} · {{ selectionLabel }}<template v-if="!alias.visible_in_models_list"> · hidden from <code class="font-mono">/v1/models</code></template>
        </p>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <Tooltip v-if="aliasWarnings.length > 0" :content="aliasWarningTooltip">
          <span
            class="inline-flex h-8 w-8 items-center justify-center rounded-md text-amber-400"
            aria-label="Alias warning"
          >
            <i class="i-lucide-alert-triangle size-4" />
          </span>
        </Tooltip>
        <button
          type="button"
          class="inline-flex h-8 w-8 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-cyan"
          aria-label="Edit alias"
          title="Edit"
          @click="$emit('edit')"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            <path d="m15 5 4 4" />
          </svg>
        </button>
        <button
          type="button"
          class="inline-flex h-8 w-8 items-center justify-center rounded-md p-1 text-gray-600 transition-colors hover:bg-white/[0.04] hover:text-accent-rose"
          aria-label="Delete alias"
          title="Delete"
          @click="$emit('delete')"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>
