<script setup lang="ts">
// Owns the model row reconciliation: keeps the merged manual+auto list in
// sync with the props, and hands the selected row down to ModelEditor.

import { computed, reactive, ref, watch } from 'vue';

import ModelEditor from './ModelEditor.vue';
import { newUiId, type Row, seedFromAuto } from './modelRows.ts';
import ModelsGrid from './ModelsGrid.vue';
import type { UpstreamModelConfig } from '../../api/types.ts';
import { modelsField } from '@floway-dev/provider';
import type { Flag, FlagDefaults, FlagOverrides } from '@floway-dev/provider/flags';
import { Button } from '@floway-dev/ui';

const manualModels = defineModel<UpstreamModelConfig[]>({ required: true });
const disabledIds = defineModel<string[]>('disabledIds', { required: true });

const emit = defineEmits<{
  'update:invalid': [invalid: boolean];
}>();

const props = withDefaults(defineProps<{
  autoModels?: UpstreamModelConfig[];
  flags: Flag[];
  upstreamFlagOverrides: FlagOverrides;
  providerFlagDefaults: FlagDefaults;
  upstreamIdLabel: string;
  // Fully read-only: no add, no mode switch, no editing.
  readOnly?: boolean;
  // All rows are persisted: no auto rows, no mode pills.
  allManual?: boolean;
  allowRerank?: boolean;
}>(), {
  autoModels: () => [],
  readOnly: false,
  allManual: false,
  allowRerank: false,
});

const rows = ref<Row[]>([]);
const selectedUiId = ref<string | null>(null);
// uiIds whose upstreamModelId is fixed (they were seeded from an auto twin
// and must keep shadowing it). Pure-manual rows have no such constraint.
const lockedUpstreamId = reactive(new Set<string>());

const parseManualModels = (value: unknown): UpstreamModelConfig[] => {
  const models = modelsField(value, 'dashboard');
  if (!props.allowRerank && models.some(model => model.kind === 'rerank')) {
    throw new Error('Rerank models require a custom upstream');
  }
  return models;
};

const anyInvalid = computed(() => {
  const models = rows.value.filter(row => row.kind === 'manual').map(row => row.config);
  try {
    parseManualModels(models);
    return false;
  } catch {
    return true;
  }
});
watch(anyInvalid, v => emit('update:invalid', v), { immediate: true });

// Reconcile the unified row list from the persisted manual models and the
// live auto list. Existing rows keep their position and uiId when their
// identity (manual config object / auto upstreamModelId) still matches, so
// external prop churn (e.g. a re-fetch) does not reorder or collapse rows.
const reconcile = () => {
  const manual = manualModels.value;
  const manualIds = new Set(manual.map(m => m.upstreamModelId));
  const auto = props.autoModels.filter(a => !manualIds.has(a.upstreamModelId));

  const prev = rows.value;
  const next: Row[] = [];
  const placedManual = new Set<UpstreamModelConfig>();
  const placedAuto = new Set<string>();

  for (const row of prev) {
    if (row.kind === 'manual') {
      if (manual.includes(row.config)) {
        next.push(row);
        placedManual.add(row.config);
      }
    } else {
      const live = auto.find(a => a.upstreamModelId === row.config.upstreamModelId);
      if (live) {
        // Refresh the snapshot in place so a re-fetch updates read-only
        // metadata without disturbing the row's identity/position.
        row.config = live;
        next.push(row);
        placedAuto.add(row.config.upstreamModelId);
      }
    }
  }

  for (const config of manual) {
    if (!placedManual.has(config)) {
      const insertAt = next.findIndex(r => r.kind === 'auto');
      const row: Row = { uiId: newUiId(), kind: 'manual', config };
      if (insertAt === -1) next.push(row); else next.splice(insertAt, 0, row);
    }
  }

  for (const a of auto) {
    if (!placedAuto.has(a.upstreamModelId)) {
      next.push({ uiId: newUiId(), kind: 'auto', config: a });
    }
  }

  rows.value = next;

  if (next.length > 0) {
    const stillExists = selectedUiId.value !== null && next.some(r => r.uiId === selectedUiId.value);
    if (!stillExists) selectedUiId.value = next[0]!.uiId;
  } else {
    selectedUiId.value = null;
  }
};

watch([manualModels, () => props.autoModels], reconcile, { immediate: true, deep: false });

const selectedRow = computed<Row | null>(() =>
  selectedUiId.value === null ? null : rows.value.find(r => r.uiId === selectedUiId.value) ?? null);

const emitManual = () => {
  manualModels.value = rows.value
    .filter(r => r.kind === 'manual')
    .map(r => r.config);
};

const addModel = () => {
  const config: UpstreamModelConfig = { upstreamModelId: '', kind: 'chat', endpoints: { chatCompletions: {} } };
  const insertAt = rows.value.findIndex(r => r.kind === 'auto');
  const uiId = newUiId();
  const row: Row = { uiId, kind: 'manual', config };
  if (insertAt === -1) rows.value.push(row); else rows.value.splice(insertAt, 0, row);
  selectedUiId.value = uiId;
  emitManual();
};

const removeRow = (uiId: string) => {
  lockedUpstreamId.delete(uiId);
  rows.value = rows.value.filter(r => r.uiId !== uiId);
  emitManual();
  if (selectedUiId.value === uiId) {
    selectedUiId.value = rows.value[0]?.uiId ?? null;
  }
};

const setMode = (uiId: string, mode: 'auto' | 'manual') => {
  const index = rows.value.findIndex(r => r.uiId === uiId);
  const row = rows.value[index];
  if (!row) return;
  if (mode === 'manual' && row.kind === 'auto') {
    // Seed an editable manual entry from the auto snapshot, keep the
    // position, and lock its upstreamModelId so it keeps shadowing the twin.
    const config = seedFromAuto(row.config);
    rows.value.splice(index, 1, { uiId, kind: 'manual', config });
    lockedUpstreamId.add(uiId);
    emitManual();
  } else if (mode === 'auto' && row.kind === 'manual') {
    // Drop the manual override and restore its auto twin in place, reusing
    // the same uiId so the row keeps its position.
    lockedUpstreamId.delete(uiId);
    const twin = props.autoModels.find(a => a.upstreamModelId === row.config.upstreamModelId);
    if (twin) rows.value.splice(index, 1, { uiId, kind: 'auto', config: twin });
    else rows.value.splice(index, 1);
    emitManual();
  }
};

const patchConfig = (patch: Partial<UpstreamModelConfig>) => {
  const row = selectedRow.value;
  if (row?.kind !== 'manual') return;
  Object.assign(row.config, patch);
  for (const key of Object.keys(patch) as (keyof UpstreamModelConfig)[]) {
    if (patch[key] === undefined) delete (row.config as unknown as Record<string, unknown>)[key];
  }
  emitManual();
};

const autoIds = computed(() => new Set(props.autoModels.map(a => a.upstreamModelId)));

const hasAutoCounterpart = (row: Row) => {
  if (props.allManual) return false;
  if (row.kind === 'auto') return true;
  return autoIds.value.has(row.config.upstreamModelId);
};

const isDisabled = (id: string): boolean => disabledIds.value.includes(id);

const setDisabled = (id: string, disabled: boolean) => {
  if (id === '') return;
  if (disabled) {
    if (!disabledIds.value.includes(id)) disabledIds.value = [...disabledIds.value, id];
  } else {
    disabledIds.value = disabledIds.value.filter(existing => existing !== id);
  }
};

// JSON edit mode — for bulk-paste of a manual model list (e.g. when
// migrating from another gateway export, or copying from a script). Auto
// rows are not serialized; they are resolved live from the upstream and
// have nothing to bulk-paste.
const editorMode = ref<'ui' | 'json'>('ui');
const jsonText = ref('');
const jsonError = ref<string | null>(null);

const serializeManual = () => JSON.stringify(manualModels.value, null, 2);

const switchEditorMode = (next: 'ui' | 'json') => {
  if (editorMode.value === next) return;
  if (next === 'json') {
    jsonText.value = serializeManual();
    jsonError.value = null;
    editorMode.value = 'json';
    return;
  }
  // Going back to UI: parse and validate. Refuse to leave JSON mode on a
  // parse error so unsaved text is preserved.
  try {
    const parsed = JSON.parse(jsonText.value);
    manualModels.value = parseManualModels(parsed);
    jsonError.value = null;
    editorMode.value = 'ui';
  } catch (e) {
    jsonError.value = `Cannot leave JSON mode: ${e instanceof Error ? e.message : String(e)}`;
  }
};

// Refresh the serialized text whenever the persisted list changes from the
// outside (the UI editor mutates it, an upstream re-fetch normalizes kinds,
// etc.) — but only while showing the UI; in JSON mode the textarea owns
// the text until the next mode switch.
watch(manualModels, () => {
  if (editorMode.value === 'ui') jsonText.value = serializeManual();
}, { deep: true });
</script>

<template>
  <div class="flex min-w-0 flex-col gap-5">
    <div class="glass-card">
      <header class="flex items-center gap-3 border-b border-white/[0.06] px-5 py-3">
        <h3 class="text-sm font-semibold text-white">Models</h3>
        <span class="text-xs text-gray-500">
          {{ rows.length }} total
          <template v-if="!allManual && !readOnly">
            · {{ rows.filter(r => r.kind === 'manual').length }} manual · {{ rows.filter(r => r.kind === 'auto').length }} auto
          </template>
        </span>
        <div class="ml-auto flex items-center gap-2">
          <Button
            v-if="!readOnly && editorMode === 'ui'"
            variant="secondary"
            size="sm"
            @click="addModel"
          >
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25">
              <path d="M5 12h14M12 5v14" />
            </svg>
            Add model
          </Button>
          <Button
            v-if="!readOnly && editorMode === 'ui'"
            variant="secondary"
            size="sm"
            @click="switchEditorMode('json')"
          >Edit as JSON</Button>
          <Button
            v-else-if="editorMode === 'json'"
            variant="secondary"
            size="sm"
            @click="switchEditorMode('ui')"
          >Edit with UI</Button>
        </div>
      </header>

      <ModelsGrid
        v-if="editorMode === 'ui'"
        :rows="rows"
        :selected-ui-id="selectedUiId"
        :read-only="readOnly"
        :all-manual="allManual"
        :has-auto-counterpart="hasAutoCounterpart"
        :is-disabled="isDisabled"
        @select="uiId => selectedUiId = uiId"
        @set-disabled="setDisabled"
        @set-mode="setMode"
      />

      <div v-else class="space-y-2 p-4">
        <textarea
          :value="jsonText"
          spellcheck="false"
          wrap="off"
          aria-label="Models JSON"
          class="block h-72 w-full resize-y rounded-lg border border-white/10 bg-surface-900/70 p-3 font-mono text-[12px] leading-[1.6] text-gray-200 focus:border-accent-cyan/50 focus:outline-none focus:ring-1 focus:ring-accent-cyan/30"
          @input="e => { jsonText = (e.target as HTMLTextAreaElement).value; jsonError = null; }"
        />
        <p v-if="jsonError" class="text-xs text-accent-rose">{{ jsonError }}</p>
        <p class="text-[11px] text-gray-500">
          Manual (overridden) models only. Auto models are resolved live from the upstream and never serialized.
        </p>
      </div>
    </div>

    <div v-if="editorMode === 'ui'" class="glass-card">
      <ModelEditor
        :row="selectedRow"
        :flags="flags"
        :upstream-flag-overrides="upstreamFlagOverrides"
        :provider-flag-defaults="providerFlagDefaults"
        :upstream-id-label="upstreamIdLabel"
        :is-upstream-id-locked="selectedRow !== null && lockedUpstreamId.has(selectedRow.uiId)"
        :has-auto-counterpart="selectedRow !== null && hasAutoCounterpart(selectedRow)"
        :mode-switchable="!readOnly && !allManual"
        :allow-rerank="allowRerank"
        @patch-config="patchConfig"
        @set-mode="next => selectedRow && setMode(selectedRow.uiId, next)"
        @remove="selectedRow && removeRow(selectedRow.uiId)"
      />
    </div>
  </div>
</template>
