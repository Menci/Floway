<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import AliasTargetRow from './AliasTargetRow.vue';
import { computeAnnouncedMetadata } from './announced-metadata.ts';
import { computeAliasLevelWarnings, realModelIdsOfKind } from './warnings.ts';
import { callApi, useApi } from '../../api/client.ts';
import type { ModelKind, AliasSelection, AliasTarget, AnnouncedMetadata, ModelAlias } from '../../api/types.ts';
import { useModelAliases } from '../../composables/useModelAliases.ts';
import { useRawModelsStore } from '../../composables/useModels.ts';
import ChatMetadataEditor from '../shared/ChatMetadataEditor.vue';
import { Button, Dialog, Input, Select, Switch } from '@floway-dev/ui';

const open = defineModel<boolean>('open', { required: true });

const props = defineProps<{
  /** null = create; non-null = edit. */
  record: ModelAlias | null;
}>();

const emit = defineEmits<{
  saved: [];
}>();

const api = useApi();
const aliasesStore = useModelAliases();
const modelsStore = useRawModelsStore();

const mode = computed<'create' | 'edit'>(() => (props.record ? 'edit' : 'create'));

// Switching kind discards rule state — a chat-only rule must not survive a
// switch into embedding/image.
const emptyRulesFor = (k: ModelKind): AliasTarget['rules'] => (k === 'chat' ? {} : {} as Record<string, never>);

const blankTarget = (k: ModelKind): AliasTarget => ({ target_model_id: '', rules: emptyRulesFor(k) });

const aliasName = ref(props.record?.name ?? '');
const displayName = ref(props.record?.display_name ?? '');
const kind = ref<ModelKind>(props.record?.kind ?? 'chat');
const selection = ref<AliasSelection>(props.record?.selection ?? 'first-available');
const visibleInModelsList = ref(props.record?.visible_in_models_list ?? true);

const targets = ref<AliasTarget[]>(
  props.record
    ? props.record.targets.map(t => ({ target_model_id: t.target_model_id, rules: { ...t.rules } as AliasTarget['rules'] }))
    : [blankTarget(kind.value)],
);

const setKind = (k: ModelKind) => {
  kind.value = k;
  targets.value = targets.value.map(t => ({ target_model_id: t.target_model_id, rules: emptyRulesFor(k) }));
};

const addTarget = () => { targets.value = [...targets.value, blankTarget(kind.value)]; };

const updateTarget = (idx: number, next: AliasTarget) => {
  const copy = targets.value.slice();
  copy[idx] = next;
  targets.value = copy;
};

const moveTarget = (idx: number, delta: -1 | 1) => {
  const j = idx + delta;
  if (j < 0 || j >= targets.value.length) return;
  const copy = targets.value.slice();
  [copy[idx], copy[j]] = [copy[j], copy[idx]];
  targets.value = copy;
};

const removeTarget = (idx: number) => {
  if (targets.value.length <= 1) return;
  targets.value = targets.value.filter((_, i) => i !== idx);
};

// ── Announced metadata ──────────────────────────────────────────────────
//
// The override is a sparse AnnouncedMetadata; null means "compute
// automatically at listing time". When the operator flips the override
// switch on, we freeze the current computed view into the buffer so the
// editor starts from a sensible baseline; flipping back off discards
// the buffer and resets the wire payload to null so the next render
// snaps back to the live computed view.

const announcedOverride = ref<AnnouncedMetadata | null>(props.record?.announced_metadata ?? null);

const computedAnnouncedMetadata = computed<AnnouncedMetadata>(() =>
  computeAnnouncedMetadata(targets.value, kind.value, modelsStore.models.value));

const overrideEnabled = computed<boolean>(() => announcedOverride.value !== null);

const showAnnouncedSection = computed(() => kind.value !== 'image');

const announcedSectionExpanded = ref(false);
const toggleAnnouncedSection = () => { announcedSectionExpanded.value = !announcedSectionExpanded.value; };

const setOverrideEnabled = (on: boolean) => {
  if (on) {
    // Freeze the live computed view into the working state — the
    // operator's edits start from what the wire surface would have
    // emitted, so a blank override doesn't visually erase the alias's
    // metadata.
    announcedOverride.value = structuredClone(computedAnnouncedMetadata.value);
  } else {
    announcedOverride.value = null;
  }
};

// Source-of-truth for the editor's `modelValue`: the override buffer when
// the operator is editing, the live computed snapshot otherwise.
const announcedEditorValue = computed<AnnouncedMetadata>(
  () => announcedOverride.value ?? computedAnnouncedMetadata.value,
);

const onAnnouncedChange = (next: AnnouncedMetadata | undefined) => {
  // Editor only fires this in manual mode (auto is read-only). Persist
  // an empty object rather than null so the override stays "on" even
  // when the operator clears every field.
  announcedOverride.value = next ?? {};
};

// Switching alias kind discards a chat-only override since the
// schema would reject it on save (e.g. embedding aliases can not
// carry a `chat` block).
watch(kind, k => {
  if (announcedOverride.value === null) return;
  if (k === 'image') {
    announcedOverride.value = null;
    return;
  }
  if (k === 'embedding' && announcedOverride.value.chat !== undefined) {
    const { chat: _drop, ...rest } = announcedOverride.value;
    announcedOverride.value = rest;
  }
});

// Suggestion list for every target-id combobox. Filtered to non-alias
// catalog rows of the alias's current kind so an embedding alias only
// hints at embedding models. Aliases never re-enter the alias layer at
// runtime, so they're excluded too. Operators can still type any
// opaque string — the list is a hint, not a constraint.
const targetIdItems = computed(() => realModelIdsOfKind(modelsStore.models.value, kind.value));

// Alias-level warnings on the live dialog state. Re-projects name +
// targets to the structural shape `computeAliasLevelWarnings` accepts so
// the Settings card row and the dialog read the same surface.
const aliasLevelWarnings = computed(() => computeAliasLevelWarnings(
  { name: aliasName.value.trim(), targets: targets.value },
  modelsStore.models.value,
));

const saving = ref(false);
const saveError = ref<string | null>(null);

// Collision check excludes the current record so an in-place edit of an
// unchanged name is allowed.
const validationError = computed<string | null>(() => {
  const trimmed = aliasName.value.trim();
  if (trimmed === '') return 'Alias id is required';
  const collisions = (aliasesStore.aliases.value ?? []).filter(a => a.name === trimmed && a.name !== props.record?.name);
  if (collisions.length > 0) return `An alias with id "${trimmed}" already exists`;
  if (targets.value.some(t => t.target_model_id.trim() === '')) return 'Every target needs a model id';
  return null;
});

const canSave = computed(() => validationError.value === null && !saving.value);

const save = async () => {
  saveError.value = validationError.value;
  if (saveError.value !== null) return;

  const trimmedName = aliasName.value.trim();
  const trimmedDisplay = displayName.value.trim();
  // The Hono RPC body type widens the per-target rules to the loose
  // `Record<string, unknown>` it gets from the Zod schema, and likewise
  // widens `announced_metadata` to its zod-inferred shape (mutable
  // modality arrays). Cast through the loose shapes so the typed body
  // matches what the schema accepts.
  const body = {
    name: trimmedName,
    kind: kind.value,
    selection: selection.value,
    display_name: trimmedDisplay === '' ? null : trimmedDisplay,
    visible_in_models_list: visibleInModelsList.value,
    targets: targets.value.map(t => ({
      target_model_id: t.target_model_id.trim(),
      rules: t.rules as Record<string, unknown>,
    })),
    announced_metadata: announcedOverride.value as Record<string, unknown> | null,
    sort_order: props.record?.sort_order ?? 0,
  };

  saving.value = true;
  try {
    if (mode.value === 'create') {
      const { error } = await callApi(() => api.api.aliases.$post({ json: body }));
      if (error) { saveError.value = error.message; return; }
    } else if (props.record) {
      const oldName = props.record.name;
      const { error } = await callApi(() => api.api.aliases[':name'].$put({
        param: { name: oldName },
        json: body,
      }));
      if (error) { saveError.value = error.message; return; }
    }
    emit('saved');
    open.value = false;
  } finally {
    saving.value = false;
  }
};

const title = computed(() => mode.value === 'create' ? 'Create Alias' : `Edit Alias: ${props.record?.name ?? ''}`);

const KIND_OPTIONS: { value: ModelKind; label: string }[] = [
  { value: 'chat', label: 'Chat' },
  { value: 'embedding', label: 'Embedding' },
  { value: 'image', label: 'Image' },
];
</script>

<template>
  <Dialog v-model:open="open" :title="title" size="xl">
    <div class="space-y-5">
      <p v-if="saveError" class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
        {{ saveError }}
      </p>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Alias id</label>
          <Input v-model="aliasName" placeholder="my-alias-id" class="font-mono" />
        </div>
        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Display name</label>
          <Input v-model="displayName" :placeholder="aliasName.trim() === '' ? 'my-alias-id' : aliasName.trim()" />
        </div>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Kind</label>
          <Select :model-value="kind" :options="KIND_OPTIONS" @update:model-value="v => setKind(v as ModelKind)" />
        </div>
        <div>
          <label class="mb-1.5 block text-xs font-medium text-gray-500">Selection</label>
          <div class="inline-flex h-9 items-center overflow-hidden rounded-[10px] border border-white/[0.14] bg-surface-700 text-xs">
            <button
              type="button"
              class="px-3 py-1.5 transition-colors"
              :class="selection === 'first-available' ? 'bg-accent-cyan/20 text-accent-cyan' : 'text-gray-400 hover:text-gray-200'"
              @click="selection = 'first-available'"
            >First available</button>
            <button
              type="button"
              class="px-3 py-1.5 transition-colors"
              :class="selection === 'random' ? 'bg-accent-cyan/20 text-accent-cyan' : 'text-gray-400 hover:text-gray-200'"
              @click="selection = 'random'"
            >Random</button>
          </div>
        </div>
      </div>

      <div>
        <div class="mb-2 flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h4 class="text-sm font-semibold text-gray-300">Models</h4>
            <p class="mt-0.5 text-xs text-gray-500">Click a model id to edit.</p>
          </div>
          <Button variant="secondary" size="sm" @click="addTarget">Add target</Button>
        </div>
        <div class="space-y-2">
          <AliasTargetRow
            v-for="(t, idx) in targets"
            :key="idx"
            :model-value="t"
            :kind="kind"
            :target-id-items="targetIdItems"
            :models="modelsStore.models.value"
            :is-first="idx === 0"
            :is-last="idx === targets.length - 1"
            :is-sole="targets.length === 1"
            @update:model-value="(next: AliasTarget) => updateTarget(idx, next)"
            @move-up="moveTarget(idx, -1)"
            @move-down="moveTarget(idx, 1)"
            @remove="removeTarget(idx)"
          />
        </div>
      </div>

      <section v-if="showAnnouncedSection" class="border-t border-white/[0.06] pt-5">
        <div class="flex items-center justify-between gap-3">
          <button
            type="button"
            class="flex flex-1 min-w-0 items-start gap-2 text-left"
            :aria-expanded="announcedSectionExpanded"
            aria-controls="announced-metadata-body"
            @click="toggleAnnouncedSection"
          >
            <svg
              class="mt-0.5 size-3.5 shrink-0 self-center text-gray-500 transition-transform"
              :class="announcedSectionExpanded && 'rotate-90'"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="m9 6 6 6-6 6" />
            </svg>
            <div class="min-w-0">
              <h4 class="text-sm font-semibold text-gray-300">Announced metadata</h4>
              <p class="mt-0.5 text-xs text-gray-500">What <code class="font-mono">/v1/models</code> reports about this alias.</p>
            </div>
          </button>
          <label class="flex shrink-0 cursor-pointer items-center gap-2">
            <Switch :model-value="overrideEnabled" @update:model-value="v => setOverrideEnabled(v === true)" />
            <span class="text-xs text-gray-400">Manual</span>
          </label>
        </div>

        <div v-if="announcedSectionExpanded" id="announced-metadata-body" class="mt-4">
          <p class="mb-3 text-xs text-gray-500">
            Defaults to the intersection across every currently-available
            target (rule-pinned sub-fields are not modifiable on client
            side so treated as unsupported).
          </p>
          <ChatMetadataEditor
            :model-value="announcedEditorValue"
            :kind="kind"
            :mode="overrideEnabled ? 'manual' : 'auto'"
            @update:model-value="onAnnouncedChange"
          />
        </div>
      </section>

      <div v-if="aliasLevelWarnings.length > 0" class="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
        <ul class="list-disc space-y-1 pl-5">
          <li v-for="w in aliasLevelWarnings" :key="w.type">
            <template v-if="w.type === 'shadow'">
              This alias name shadows a real model id:
              <code class="font-mono">{{ w.shadowedId }}</code>
              <template v-if="w.shadowedDisplayName !== null">
                (<strong class="font-semibold">{{ w.shadowedDisplayName }}</strong>).
              </template>
              <template v-else>.</template>
            </template>
            <template v-else>{{ w.message }}</template>
          </li>
        </ul>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-5">
        <label class="flex items-center gap-2">
          <Switch v-model="visibleInModelsList" />
          <span class="text-sm text-gray-300">Visible in <code class="font-mono">/v1/models</code></span>
        </label>
        <div class="flex items-center gap-2">
          <Button variant="secondary" :disabled="saving" @click="open = false">Cancel</Button>
          <Button :loading="saving" :disabled="!canSave" @click="save">Save</Button>
        </div>
      </div>
    </div>
  </Dialog>
</template>
