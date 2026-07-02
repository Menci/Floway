<script setup lang="ts">
// Shared editor for a chat/embedding model's `limits` + `chat` metadata.
// Hosts the Limits + Modalities + Reasoning sub-blocks consumed by both
// `ModelEditor.vue` (a real catalog row's editor) and
// `AliasEditDialog.vue` (the alias's announced-metadata override).
//
// Controlled component: the parent owns the `mode` flip.
//   - `mode === 'manual'` → every field is editable; interactions emit.
//   - `mode === 'auto'`   → every field renders read-only; interactions
//     are no-ops. The parent passes in the computed snapshot via
//     `modelValue` so the operator still sees the live values.
//
// Kind-gated sub-blocks:
//   - `chat`      → Limits + Modalities + Reasoning.
//   - `embedding` → Limits only.
//   - `image`     → renders nothing (callers should not mount this).

import { computed, ref, watch } from 'vue';

import type { AnnouncedMetadata, ChatModelInfo, ModelKind } from '../../api/types.ts';
import { parseOptionalNumber } from '../../utils/parse-optional-number.ts';
import { Button, Input, Switch, Tooltip } from '@floway-dev/ui';

const props = defineProps<{
  modelValue: AnnouncedMetadata | undefined;
  kind: ModelKind;
  mode: 'auto' | 'manual';
}>();

const emit = defineEmits<{
  'update:modelValue': [next: AnnouncedMetadata | undefined];
}>();

const value = computed<AnnouncedMetadata>(() => props.modelValue ?? {});
const editable = computed(() => props.mode === 'manual');
const showChatBlocks = computed(() => props.kind === 'chat');
const renderAnything = computed(() => props.kind !== 'image');

// Known Codex CLI effort presets as of v0.137. Codex's wire type is open
// (ReasoningEffort::Custom(String)) so any string is accepted upstream;
// these are just the convenient quick-adds. See:
// https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs
const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

// Strip empty sub-blocks so the wire payload stays minimal — the alias
// listing fallback only kicks in for absent fields; the upstream model
// config likewise treats a missing key as "inherit".
const patch = (next: AnnouncedMetadata) => {
  if (!editable.value) return;
  const out: AnnouncedMetadata = {};
  if (next.limits && Object.keys(next.limits).length > 0) out.limits = next.limits;
  if (next.chat && (next.chat.modalities !== undefined || next.chat.reasoning !== undefined)) out.chat = next.chat;
  emit('update:modelValue', Object.keys(out).length > 0 ? out : undefined);
};

// ── Limits ────────────────────────────────────────────────────────────

const updateLimit = (
  key: 'max_context_window_tokens' | 'max_prompt_tokens' | 'max_output_tokens',
  raw: string | number | null | undefined,
) => {
  if (!editable.value) return;
  const limits = { ...(value.value.limits ?? {}) };
  const num = parseOptionalNumber(raw);
  if (num === undefined) delete limits[key];
  else limits[key] = num;
  patch({ ...value.value, limits: Object.keys(limits).length > 0 ? limits : undefined });
};

// ── Chat builder helpers ──────────────────────────────────────────────

const buildNextChat = (partial: Partial<ChatModelInfo>): ChatModelInfo | undefined => {
  const base = value.value.chat ?? {};
  const next: ChatModelInfo = { ...base, ...partial };

  // Normalise: omit modalities when it would only carry the default
  // (text-only) shape.
  const hasImageInput = next.modalities?.input.includes('image') === true;
  next.modalities = hasImageInput
    ? { input: ['text', 'image'], output: ['text'] }
    : undefined;

  if (!next.modalities && !next.reasoning) return undefined;
  return next;
};

const buildNextReasoning = (
  update: Partial<NonNullable<ChatModelInfo['reasoning']>>,
): ChatModelInfo['reasoning'] => {
  const base = value.value.chat?.reasoning ?? {};
  const merged = { ...base, ...update };
  const cleaned = Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined),
  ) as NonNullable<ChatModelInfo['reasoning']>;
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
};

const setChat = (chat: ChatModelInfo | undefined) => {
  patch({ ...value.value, chat });
};

// ── Modalities ────────────────────────────────────────────────────────

const chatImageInput = computed<boolean>(
  () => value.value.chat?.modalities?.input.includes('image') ?? false,
);

const toggleImageInput = (on: boolean) => {
  if (!editable.value) return;
  setChat(buildNextChat({ modalities: on ? { input: ['text', 'image'], output: ['text'] } : undefined }));
};

// ── Reasoning sub-block enabled states ────────────────────────────────

const effortEnabled = computed(() => value.value.chat?.reasoning?.effort !== undefined);
const budgetTokensEnabled = computed(() => value.value.chat?.reasoning?.budget_tokens !== undefined);
const adaptiveEnabled = computed(() => value.value.chat?.reasoning?.adaptive === true);
const mandatoryEnabled = computed(() => value.value.chat?.reasoning?.mandatory === true);

// Mandatory is exclusive: when on, the three operator-controlled toggles
// lock off. When any of those is on, Mandatory locks off. UI-only
// constraint (the schema would technically accept any subset).
const anyControlledEnabled = computed(() => effortEnabled.value || budgetTokensEnabled.value || adaptiveEnabled.value);
const controlledDisabled = computed(() => !editable.value || mandatoryEnabled.value);
const mandatoryDisabled = computed(() => !editable.value || anyControlledEnabled.value);

const supportedEfforts = computed<readonly string[]>(
  () => value.value.chat?.reasoning?.effort?.supported ?? [],
);
const presetEffortLevels = computed(() => REASONING_LEVELS.filter(level => !supportedEfforts.value.includes(level)));

// Free-typing input for adding a custom reasoning level not in the quick-add list.
const reasoningLevelInput = ref('');

// Resync input buffer when the active kind changes (parent may swap the
// hosted record under us).
watch(() => props.kind, () => { reasoningLevelInput.value = ''; });

// ── Effort sub-block ──────────────────────────────────────────────────

const toggleEffort = (on: boolean) => {
  if (!editable.value) return;
  const reasoning = on
    ? buildNextReasoning({ effort: { supported: ['low', 'medium', 'high'], default: 'medium' } })
    : buildNextReasoning({ effort: undefined });
  setChat(buildNextChat({ reasoning }));
};

const addReasoningLevel = (level: string) => {
  if (!editable.value) return;
  const trimmed = level.trim();
  if (trimmed === '') return;
  const current = supportedEfforts.value;
  if (current.includes(trimmed)) return;
  const updated = [...current, trimmed];
  const existing = value.value.chat?.reasoning?.effort;
  setChat(buildNextChat({ reasoning: buildNextReasoning({ effort: { supported: updated, default: existing?.default ?? '' } }) }));
};

const removeReasoningLevel = (level: string) => {
  if (!editable.value) return;
  const current = supportedEfforts.value;
  const removedIndex = current.indexOf(level);
  const updated = current.filter(e => e !== level);
  const existingEffort = value.value.chat?.reasoning?.effort;
  // The default must always be one of the supported levels (or empty
  // when the list itself is empty). When the operator deletes the
  // current default, pick the neighbor that slides into the same index
  // slot — falling back to the new tail when the removed entry was the
  // last one.
  let nextDefault = existingEffort?.default ?? '';
  if (existingEffort?.default === level) {
    if (updated.length === 0) nextDefault = '';
    else if (removedIndex < updated.length) nextDefault = updated[removedIndex]!;
    else nextDefault = updated[updated.length - 1]!;
  }
  setChat(buildNextChat({ reasoning: buildNextReasoning({ effort: { supported: updated, default: nextDefault } }) }));
};

const commitReasoningInput = () => {
  const trimmed = reasoningLevelInput.value.trim();
  if (trimmed === '') return;
  addReasoningLevel(trimmed);
  reasoningLevelInput.value = '';
};

const setDefaultEffort = (level: string) => {
  if (!editable.value) return;
  const current = supportedEfforts.value;
  setChat(buildNextChat({ reasoning: buildNextReasoning({ effort: { supported: current, default: level } }) }));
};

// ── Effort tag drag-to-reorder ────────────────────────────────────────
//
// HTML5 DnD distinguishes drag from click via a built-in pointer-distance
// threshold: a mousedown+mouseup with no movement still fires `click`
// (and sets the default), while a mousedown+drag+drop suppresses click
// entirely. So the two affordances coexist on the same button element.
const draggedEffortIndex = ref<number | null>(null);
const dragOverEffortIndex = ref<number | null>(null);

const onEffortDragStart = (index: number, e: DragEvent) => {
  if (!editable.value) return;
  draggedEffortIndex.value = index;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    // Firefox requires setData to actually initiate the drag.
    e.dataTransfer.setData('text/plain', String(index));
  }
};

const onEffortDragOver = (index: number, e: DragEvent) => {
  if (draggedEffortIndex.value === null) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  dragOverEffortIndex.value = index;
};

const onEffortDragLeave = (index: number) => {
  if (dragOverEffortIndex.value === index) dragOverEffortIndex.value = null;
};

const onEffortDrop = (index: number, e: DragEvent) => {
  e.preventDefault();
  const from = draggedEffortIndex.value;
  draggedEffortIndex.value = null;
  dragOverEffortIndex.value = null;
  if (from === null || from === index || !editable.value) return;
  const current = [...supportedEfforts.value];
  const [moved] = current.splice(from, 1);
  if (moved === undefined) return;
  current.splice(index, 0, moved);
  const existing = value.value.chat?.reasoning?.effort;
  setChat(buildNextChat({ reasoning: buildNextReasoning({ effort: { supported: current, default: existing?.default ?? '' } }) }));
};

const onEffortDragEnd = () => {
  draggedEffortIndex.value = null;
  dragOverEffortIndex.value = null;
};

// ── Budget tokens sub-block ───────────────────────────────────────────

const toggleBudgetTokens = (on: boolean) => {
  if (!editable.value) return;
  const reasoning = on
    ? buildNextReasoning({ budget_tokens: {} })
    : buildNextReasoning({ budget_tokens: undefined });
  setChat(buildNextChat({ reasoning }));
};

const updateBudgetTokensMin = (raw: string | number | null | undefined) => {
  if (!editable.value) return;
  const num = parseOptionalNumber(raw);
  const current = value.value.chat?.reasoning?.budget_tokens ?? {};
  const next = { ...current };
  if (num === undefined) delete next.min; else next.min = num;
  setChat(buildNextChat({ reasoning: buildNextReasoning({ budget_tokens: next }) }));
};

const updateBudgetTokensMax = (raw: string | number | null | undefined) => {
  if (!editable.value) return;
  const num = parseOptionalNumber(raw);
  const current = value.value.chat?.reasoning?.budget_tokens ?? {};
  const next = { ...current };
  if (num === undefined) delete next.max; else next.max = num;
  setChat(buildNextChat({ reasoning: buildNextReasoning({ budget_tokens: next }) }));
};

// ── Adaptive / Mandatory toggles ──────────────────────────────────────

const toggleAdaptive = (on: boolean) => {
  if (!editable.value) return;
  const reasoning = on
    ? buildNextReasoning({ adaptive: true })
    : buildNextReasoning({ adaptive: undefined });
  setChat(buildNextChat({ reasoning }));
};

const toggleMandatory = (on: boolean) => {
  if (!editable.value) return;
  const reasoning = on
    ? buildNextReasoning({ mandatory: true })
    : buildNextReasoning({ mandatory: undefined });
  setChat(buildNextChat({ reasoning }));
};
</script>

<template>
  <div v-if="renderAnything" class="space-y-6">
    <section>
      <div class="mb-3 flex items-baseline gap-3">
        <h4 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Limits</h4>
        <span class="text-[11px] text-gray-500">tokens</span>
      </div>
      <div class="grid gap-3 sm:grid-cols-3">
        <label class="block space-y-1.5">
          <span class="block text-xs font-medium text-gray-500">Context Window</span>
          <Input
            type="number"
            :model-value="value.limits?.max_context_window_tokens"
            :readonly="!editable"
            placeholder="e.g. 1050000"
            class="font-mono"
            @update:model-value="v => updateLimit('max_context_window_tokens', v)"
          />
        </label>
        <label class="block space-y-1.5">
          <span class="block text-xs font-medium text-gray-500">Prompt Tokens</span>
          <Input
            type="number"
            :model-value="value.limits?.max_prompt_tokens"
            :readonly="!editable"
            placeholder="e.g. 922000"
            class="font-mono"
            @update:model-value="v => updateLimit('max_prompt_tokens', v)"
          />
        </label>
        <label class="block space-y-1.5">
          <span class="block text-xs font-medium text-gray-500">Output Tokens</span>
          <Input
            type="number"
            :model-value="value.limits?.max_output_tokens"
            :readonly="!editable"
            placeholder="e.g. 128000"
            class="font-mono"
            @update:model-value="v => updateLimit('max_output_tokens', v)"
          />
        </label>
      </div>
    </section>

    <section v-if="showChatBlocks">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h4 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Modalities</h4>
        <label class="flex items-center gap-2" :class="editable ? 'cursor-pointer' : 'cursor-not-allowed'">
          <Switch
            :model-value="chatImageInput"
            :disabled="!editable"
            @update:model-value="v => toggleImageInput(v === true)"
          />
          <span class="text-xs" :class="chatImageInput ? 'text-white' : 'text-gray-500'">Image input</span>
        </label>
      </div>
    </section>

    <section v-if="showChatBlocks">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h4 class="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Reasoning</h4>
        <label class="flex items-center gap-2" :class="controlledDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'">
          <Switch :model-value="effortEnabled" :disabled="controlledDisabled" @update:model-value="v => toggleEffort(v === true)" />
          <span class="text-xs" :class="effortEnabled ? 'text-white' : 'text-gray-500'">Effort levels</span>
        </label>
        <label class="flex items-center gap-2" :class="controlledDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'">
          <Switch :model-value="budgetTokensEnabled" :disabled="controlledDisabled" @update:model-value="v => toggleBudgetTokens(v === true)" />
          <span class="text-xs" :class="budgetTokensEnabled ? 'text-white' : 'text-gray-500'">Budget tokens</span>
        </label>
        <label class="flex items-center gap-2" :class="controlledDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'">
          <Switch :model-value="adaptiveEnabled" :disabled="controlledDisabled" @update:model-value="v => toggleAdaptive(v === true)" />
          <span class="text-xs" :class="adaptiveEnabled ? 'text-white' : 'text-gray-500'">Adaptive</span>
          <Tooltip content="Model self-selects reasoning effort"><span class="text-[10px] text-gray-600">?</span></Tooltip>
        </label>
        <label class="flex items-center gap-2" :class="mandatoryDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'">
          <Switch :model-value="mandatoryEnabled" :disabled="mandatoryDisabled" @update:model-value="v => toggleMandatory(v === true)" />
          <span class="text-xs" :class="mandatoryEnabled ? 'text-white' : 'text-gray-500'">Mandatory</span>
          <Tooltip content="Reasoning is always applied; caller cannot opt out"><span class="text-[10px] text-gray-600">?</span></Tooltip>
        </label>
      </div>

      <div v-if="effortEnabled" class="mt-3 space-y-1.5 border-l-2 border-white/[0.08] pl-3">
        <div class="flex min-h-[1.625rem] flex-wrap items-center gap-x-3 gap-y-1.5">
          <span class="text-xs font-semibold text-gray-300">Effort levels</span>
          <span v-if="editable" class="text-[11px] text-gray-500">(click to set default)</span>
          <template v-if="supportedEfforts.length > 0">
            <button
              v-for="(level, index) in supportedEfforts"
              :key="level"
              type="button"
              class="inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-[11px] transition-colors"
              :class="[
                value.chat?.reasoning?.effort?.default === level
                  ? 'border-accent-cyan/50 bg-accent-cyan/10 text-accent-cyan font-semibold'
                  : 'border-white/15 bg-white/[0.07] text-gray-300 hover:border-white/30 hover:text-white',
                editable ? 'cursor-grab active:cursor-grabbing' : 'cursor-not-allowed',
                draggedEffortIndex === index && 'opacity-40',
                dragOverEffortIndex === index && draggedEffortIndex !== index && 'ring-1 ring-accent-cyan',
              ]"
              :disabled="!editable"
              :draggable="editable"
              :title="value.chat?.reasoning?.effort?.default === level ? 'Default — click another to switch, drag to reorder' : 'Click to set as default, drag to reorder'"
              @click="setDefaultEffort(level)"
              @dragstart="e => onEffortDragStart(index, e)"
              @dragover="e => onEffortDragOver(index, e)"
              @dragleave="onEffortDragLeave(index)"
              @drop="e => onEffortDrop(index, e)"
              @dragend="onEffortDragEnd"
            >
              {{ level }}
              <span
                v-if="editable"
                role="button"
                tabindex="0"
                class="ml-0.5 cursor-pointer text-gray-500 transition-colors hover:text-accent-rose"
                :aria-label="`Remove ${level}`"
                @click.stop="removeReasoningLevel(level)"
                @keydown.enter.stop.prevent="removeReasoningLevel(level)"
              >
                <svg class="h-2.5 w-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M9 3 3 9M3 3l6 6" />
                </svg>
              </span>
            </button>
          </template>
          <p v-else-if="editable" class="whitespace-nowrap text-[11px] text-accent-amber">Add at least one effort level — click a preset on the right.</p>
          <p v-else class="whitespace-nowrap text-[11px] text-gray-500">—</p>
        </div>
        <div v-if="editable" class="flex flex-wrap items-center gap-1.5">
          <button
            v-for="level in presetEffortLevels"
            :key="level"
            type="button"
            class="rounded border border-white/15 px-2 py-0.5 font-mono text-[11px] text-gray-400 transition-colors hover:border-accent-cyan/40 hover:text-accent-cyan"
            @click="addReasoningLevel(level)"
          >+ {{ level }}</button>
          <Input
            v-model="reasoningLevelInput"
            size="sm"
            placeholder="custom…"
            class="!h-6 !w-28 !py-0 !text-[11px] font-mono"
            @keydown.enter.prevent="commitReasoningInput"
          />
          <Button variant="secondary" size="sm" class="!h-6 !px-2 !py-0 !text-[11px]" @click="commitReasoningInput">Add</Button>
        </div>
      </div>

      <div v-if="budgetTokensEnabled" class="mt-3 flex flex-wrap items-center gap-3 border-l-2 border-white/[0.08] pl-3">
        <span class="text-xs font-semibold text-gray-300">Budget tokens</span>
        <label class="flex items-center gap-1.5">
          <span class="text-[11px] text-gray-500">Min</span>
          <Input
            type="number"
            min="0"
            size="sm"
            :model-value="value.chat?.reasoning?.budget_tokens?.min"
            :readonly="!editable"
            placeholder="—"
            class="!h-6 !w-24 !py-0 !text-[11px] font-mono"
            @update:model-value="v => updateBudgetTokensMin(v)"
          />
        </label>
        <label class="flex items-center gap-1.5">
          <span class="text-[11px] text-gray-500">Max</span>
          <Input
            type="number"
            min="0"
            size="sm"
            :model-value="value.chat?.reasoning?.budget_tokens?.max"
            :readonly="!editable"
            placeholder="—"
            class="!h-6 !w-24 !py-0 !text-[11px] font-mono"
            @update:model-value="v => updateBudgetTokensMax(v)"
          />
        </label>
        <p
          v-if="value.chat?.reasoning?.budget_tokens?.min !== undefined
            && value.chat?.reasoning?.budget_tokens?.max !== undefined
            && value.chat.reasoning.budget_tokens.max < value.chat.reasoning.budget_tokens.min"
          class="text-[11px] text-accent-amber"
        >
          Max must be ≥ min.
        </p>
      </div>
    </section>
  </div>
</template>
